import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import {
  measureScaP03BootstrapCandidateV3,
  finalizeScaP03BootstrapRecordV3,
} from "../src/p03-bootstrap-v3.js";
import {
  createScaP03BootstrapHostAuthorityV1,
  verifyScaP03BootstrapProofV3,
  type ScaP03BootstrapHostProbeV1,
} from "../src/p03-bootstrap-host.js";
import type { ScaP03HostWitnessSinkV1 } from "../src/p03-bootstrap-witness.js";
import { ScaP03WorkspaceRegistryV1 } from "../src/p03-bootstrap-workspaces.js";
import {
  runScaP03BootstrapCliV1,
  type ScaP03BootstrapCliDepsV1,
} from "../src/p03-bootstrap-cli.js";
import { readStableScaP03FileV1 } from "../src/p03-bootstrap-local-probe.js";
import { createScaP03ProductionHostCompositionV1 } from "../src/p03-production-runtime.js";
import {
  ScaP03CliSealedHandoffSchema,
  ScaP03CliVerifyManifestSchema,
  ScaP03CliFreezeHandoffSchema,
  ScaP03CliFreezeManifestSchema,
  parseScaP03CliCanonical,
} from "../src/p03-bootstrap-cli-contracts.js";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore, previewArtifactRef } from "../../orchestration/dist/artifact-store.js";
import {
  freezeScaP03BootstrapV3,
  planScaP03ImplementationV3,
  type ScaP03FreezeManifestV3,
} from "../src/p03-bootstrap-freeze.js";
import { readSourceOracle } from "./p03-source-oracle.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactRef } from "../../orchestration/dist/contracts.js";
import {
  SCA_P03_ATTESTATION_BINDING_V2_SCHEMA,
  SCA_P03_BOOTSTRAP_REVIEW_V2_SCHEMA,
  SCA_P03_CLEANUP_EVIDENCE_V2_SCHEMA,
  SCA_P03_ISOLATION_EVIDENCE_V2_SCHEMA,
  SCA_P03_PRODUCTION_QUALIFICATION_RECORD_V1_SCHEMA,
  validateScaP03AttemptWitnessV1,
  validateScaP03BootstrapQualificationRecordV3,
  validateScaP03ProductionQualificationRecordV1,
  type ScaP03BootstrapQualificationRecordV2,
} from "../../orchestration/dist/sca/p03-bootstrap-contracts.js";
import {
  SCA_P03_PRODUCTION_INPUT_CONTRACTS,
  SCA_P03_QUERY_IDS,
  deriveScaP03GraphSupportEntriesV1,
  SCA_P03_SOURCE_ORACLE_PRODUCER,
  SCA_P03_SOURCE_ORACLE_SCHEMA,
  SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
  SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
  SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
  SCA_P03_SOURCE_ORACLE_VALIDATOR,
  projectSourceOracleCases,
  scaP03QualificationObservationSha256V2,
  sealSourceOracleValidationReceipt,
  scaP03OracleBoundReleaseSha256V2,
  validateScaP03QualificationFixtureCorpusV2,
  validateScaP03JoernRuntimeIdentityV1,
  validateScaP03QueryPlanV2,
  validateScaP03RuntimePolicyV1,
  validateScaP03QualificationProfileV2,
  validateScaP03OperationRequestV1,
  withScaP03Digest,
} from "../../orchestration/dist/sca/p03-contracts.js";
import { validateSourceOracleBytes } from "../src/p03-source-oracle.js";
import { p03HostOwnerRegression } from "./p03-host-owner-regression.js";
import { syntheticSourceOracle } from "./p03-synthetic-source-oracle.js";
import { observedFromSourceCase } from "./p03-test-oracle.js";
import {
  P03_BOOTSTRAP_EVIDENCE_SCHEMAS,
  P03_BOOTSTRAP_ROLES,
  createScaP03FrozenProductionBindingsV1,
  evaluateScaP03BootstrapCandidateV2,
  readP03BootstrapInputs,
  validateScaP03FrozenProductionBindingsV1,
  verifyScaP03BootstrapProofV2,
  verifyScaP03DeterministicTestProofV2,
  type ScaP03BootstrapHostAuthorityV1,
} from "../src/p03-bootstrap.js";
import {
  createScaP03DockerDeterministicTestQualifiedRuntimeV1,
  createScaP03DockerBootstrapDeterministicTestOnlyRuntimeV3,
  isVerifiedScaP03DockerHostRuntimeV1,
  type DockerRunnerV1,
  type ScaP03DockerCandidateConfigV1,
  ScaP03DockerCandidateV1,
} from "../src/p03-docker-runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const digest = (text: string) => sha256(text);
const stamp = "2026-09-23T12:00:00.000Z";

function testFixture(run_id = "bootstrap-test", sharedStore?: ArtifactStore, reviewed = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "p03-bootstrap-test-"));
  roots.push(root);
  const store = sharedStore ?? ArtifactStore.provision(path.join(root, "artifacts"));
  let counter = 0;
  function persist(
    value: unknown,
    kind: string,
    producer: string = Object.values(SCA_P03_PRODUCTION_INPUT_CONTRACTS).find(
      (entry) => entry.kind === kind
    )?.producer ?? P03_BOOTSTRAP_ROLES.frozen,
    upstream_refs: ArtifactRef[] = [],
    parent_ref: ArtifactRef | null = null,
    schema_id?: string
  ): ArtifactRef {
    const operation_id = `proof-${String(++counter)}`;
    if (
      schema_id === undefined &&
      value !== null &&
      typeof value === "object" &&
      "schema_id" in value &&
      typeof value.schema_id === "string"
    )
      schema_id = value.schema_id;
    if (schema_id === undefined) throw new Error("test artifact schema required");
    return store.persist({
      metadata: {
        schema_version: 2,
        run_id,
        phase: "SCA-P03",
        branch_id: null,
        kind,
        operation_id,
        version: 1,
        producer,
        media_type: "application/json",
        content_schema: { schema_id, schema_version: Number(schema_id.slice(-1)) },
        parent_ref,
        upstream_refs,
      },
      content: canonicalJson(value),
    });
  }
  const pkg = persist(
    { package: "pinned" },
    "sca-p03-runtime-package",
    P03_BOOTSTRAP_ROLES.frozen,
    [],
    null,
    P03_BOOTSTRAP_EVIDENCE_SCHEMAS.package
  );
  const identity = withScaP03Digest(
    {
      schema_id: "penny.sca-p03-joern-runtime-identity.v1",
      schema_version: 1,
      runtime_id: "runtime",
      runtime_kind: "host_qualified_joern",
      qualification_scope: "live_qualified",
      root_tool_id: "joern",
      root_executable_ref: pkg,
      root_measurement_ref: pkg,
      toolchain_ref: pkg,
      runtime_package_refs: [pkg],
      runtime_tree_sha256: "b".repeat(64),
      joern_version: "4.0.627",
      php_frontend_version: "4.0.627",
      javascript_frontend_version: "4.0.627",
      jvm_version: "1",
      php_runtime_version: "1",
      helper_version: "1",
    },
    "identity_sha256"
  );
  const identityRef = persist(
    identity,
    "sca-p03-joern-runtime-identity",
    SCA_P03_PRODUCTION_INPUT_CONTRACTS.runtime_identity.producer,
    [pkg]
  );
  const implementation = withScaP03Digest(
    {
      schema_id: "penny.sca-p03-implementation-identity.v1",
      schema_version: 1,
      implementation_id: "implementation",
      implementation_revision: "rev1",
      source_sha256: digest("source"),
      build_sha256: digest("build"),
      normalizer_sha256: digest("normalizer"),
      query_runner_sha256: digest("runner"),
    },
    "implementation_sha256"
  );
  const implementationRef = persist(implementation, "sca-p03-implementation-identity");
  const fidelity_requirements = (["php", "javascript", "typescript"] as const).flatMap(
    (language) => {
      const partition = language === "php" ? "php" : "javascript_typescript";
      return [
        {
          requirement_id: `${language}-language`,
          dimension: "language",
          subject: language,
          partition,
          materiality: "material",
          complement_evidence_ref: null,
        },
        ...(["framework", "edge_class", "surface"] as const)
          .filter(() => language !== "typescript")
          .map((dimension) => ({
            requirement_id: `${language}-${dimension}`,
            dimension,
            subject: dimension === "edge_class" ? "call" : "fixture",
            partition,
            materiality: dimension === "framework" && !reviewed ? "non_material" : "material",
            complement_evidence_ref: null,
          })),
      ];
    }
  );
  const profile = withScaP03Digest(
    {
      schema_id: "penny.sca-p03-qualification-profile.v2",
      schema_version: 2,
      profile_id: "profile",
      phase_id: "SCA-P03",
      required_languages: ["php", "javascript", "typescript"],
      required_query_ids: SCA_P03_QUERY_IDS,
      fidelity_requirements,
      requires_live_runtime: true,
      criterion_ids: [
        "AC-P03.graph-construction",
        "AC-P03.baseline-queries",
        "AC-P03.recovery-cancellation",
        "AC-P03.zero-model-ordering",
      ],
    },
    "profile_sha256"
  );
  const profileRef = persist(profile, "sca-p03-qualification-profile");
  const oracle = reviewed
    ? validateSourceOracleBytes(
        readFileSync(new URL("./fixtures/p03-v2/oracle.json", import.meta.url))
      )
    : syntheticSourceOracle();
  const fixtures = (["php", "javascript", "typescript"] as const).map((language) => {
    const definition = oracle.fixtures.find((item) => item.language === language);
    if (definition === undefined) throw new Error("missing reviewed fixture");
    const bytes = readFileSync(new URL(`./fixtures/p03-v2/${definition.file}`, import.meta.url));
    return {
      fixture_id: definition.fixture_id,
      language,
      path: definition.path,
      bytes,
      content_sha256: sha256(bytes),
    };
  });
  const fixtureRefs = fixtures.map((fixture) =>
    persist(
      {
        schema_id: "penny.sca-p03-qualification-fixture-content.v1",
        schema_version: 1,
        fixture_id: fixture.fixture_id,
        language: fixture.language,
        path: fixture.path,
        encoding: "base64",
        content_base64: fixture.bytes.toString("base64"),
        byte_length: fixture.bytes.byteLength,
        content_sha256: fixture.content_sha256,
      },
      "sca-p03-qualification-fixture-content"
    )
  );
  const queries = SCA_P03_QUERY_IDS.map((query_id, index) => {
    const plan = withScaP03Digest(
      {
        schema_id: "penny.sca-p03-query-plan.v2",
        schema_version: 2,
        plan_id: `plan-${String(index)}`,
        query_id,
        steps: [
          { kind: "select_node", node_class: "method" },
          {
            kind: "filter_property",
            property: "file_name",
            operator: "equals",
            value: "src/a.php",
          },
          ...(query_id === "p03.call-resolution.v2" || query_id === "p03.framework-dispatch.v2"
            ? [{ kind: "traverse_edge", edge: "call", max_hops: 1 }]
            : query_id === "p03.control-guard.v2"
              ? [{ kind: "traverse_edge", edge: "cfg", max_hops: 1 }]
              : query_id === "p03.dataflow-source-sink.v2"
                ? [{ kind: "traverse_edge", edge: "reaching_def", max_hops: 1 }]
                : []),
          { kind: "limit", max_items: 10 },
        ],
        max_ast_depth: 8,
        max_ast_nodes: 32,
      },
      "plan_sha256"
    );
    const planRef = persist(plan, "sca-p03-query-plan");
    const binding = {
      schema_id: "penny.sca-p03-query-binding.v2" as const,
      schema_version: 2 as const,
      release_id: "release",
      query_id,
      executor_id: query_id,
      plan_id: plan.plan_id,
      plan_sha256: plan.plan_sha256,
    };
    const scriptBytes = Buffer.from(canonicalJson(binding));
    const script = {
      schema_id: "penny.sca-p03-query-script.v2",
      schema_version: 2,
      query_id,
      script_id: `script-${String(index)}`,
      language: "penny_typed_query_binding_v2",
      review_status: "host_reviewed_frozen",
      encoding: "base64",
      content_base64: scriptBytes.toString("base64"),
      byte_length: scriptBytes.byteLength,
      content_sha256: sha256(scriptBytes),
    };
    const scriptRef = persist(script, "sca-p03-query-script");
    return {
      query_id,
      script_ref: scriptRef,
      script_sha256: scriptRef.content_digest,
      plan_ref: planRef,
      plan_sha256: planRef.content_digest,
      script_id: script.script_id,
      script_content_sha256: script.content_sha256,
      binding,
      plan,
    };
  });
  const set = withScaP03Digest(
    {
      schema_id: "penny.sca-p03-baseline-query-set.v2",
      schema_version: 2,
      query_set_id: "set",
      release_id: "release",
      native_query_authorized: false,
      ordered_queries: queries.map(
        ({ query_id, script_ref, script_sha256, plan_ref, plan_sha256 }) => ({
          query_id,
          script_ref,
          script_sha256,
          plan_ref,
          plan_sha256,
        })
      ),
    },
    "query_set_sha256"
  );
  const setRef = persist(
    set,
    "sca-p03-baseline-query-set",
    SCA_P03_PRODUCTION_INPUT_CONTRACTS.baseline_query_set.producer,
    [...queries.map((q) => q.script_ref), ...queries.map((q) => q.plan_ref)]
  );
  const expected_cases = projectSourceOracleCases(oracle);
  const corpus = withScaP03Digest(
    {
      schema_id: "penny.sca-p03-qualification-fixture-corpus.v2",
      schema_version: 2,
      corpus_id: "corpus",
      fixture_content_refs: fixtureRefs,
      fixture_ids: fixtures.map((fixture) => fixture.fixture_id),
      languages: ["php", "javascript", "typescript"],
      expected_cases,
    },
    "corpus_sha256"
  );
  const corpusRef = persist(
    corpus,
    "sca-p03-qualification-fixture-corpus",
    SCA_P03_PRODUCTION_INPUT_CONTRACTS.fixture_corpus.producer,
    fixtureRefs
  );
  const oracleRef = persist(
    oracle,
    "sca-p03-source-oracle",
    SCA_P03_SOURCE_ORACLE_PRODUCER,
    [],
    null,
    SCA_P03_SOURCE_ORACLE_SCHEMA
  );
  const [php, javascript, typescript] = fixtures;
  if (!php || !javascript || !typescript) throw new Error("fixture roster incomplete");
  const reviewBody = {
    schema_id: SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
    schema_version: 1,
    producer: SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
    oracle_sha256: oracle.oracle_sha256,
    parser_identity_sha256: oracle.parser.identity_sha256,
    fixture_content_sha256: fixtures.map((fixture) => fixture.content_sha256),
    expected_cases,
  };
  const reviewRef = persist(
    { ...reviewBody, review_sha256: sha256(canonicalJson(reviewBody)) },
    "sca-p03-source-oracle-review",
    SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
    [oracleRef],
    null,
    SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA
  );
  const fixtureRef = (index: number): ArtifactRef => {
    const ref = fixtureRefs[index];
    if (ref === undefined) throw new Error("fixture ref missing");
    return ref;
  };
  const receipt = sealSourceOracleValidationReceipt({
    oracle_ref: oracleRef,
    oracle_sha256: oracle.oracle_sha256,
    review_ref: reviewRef,
    parser_identity_sha256: oracle.parser.identity_sha256,
    fixtures: [
      {
        fixture_id: php.fixture_id,
        language: php.language,
        content_ref: fixtureRef(0),
        content_sha256: php.content_sha256,
      },
      {
        fixture_id: javascript.fixture_id,
        language: javascript.language,
        content_ref: fixtureRef(1),
        content_sha256: javascript.content_sha256,
      },
      {
        fixture_id: typescript.fixture_id,
        language: typescript.language,
        content_ref: fixtureRef(2),
        content_sha256: typescript.content_sha256,
      },
    ],
    corpus_ref: corpusRef,
    corpus_sha256: corpus.corpus_sha256,
    expected_cases,
    validated_at: stamp,
  });
  const receiptRef = persist(
    receipt,
    "sca-p03-source-oracle-validation",
    SCA_P03_SOURCE_ORACLE_VALIDATOR,
    [oracleRef, corpusRef, ...fixtureRefs, reviewRef].sort((a, b) =>
      a.artifact_id.localeCompare(b.artifact_id)
    ),
    null,
    SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA
  );
  const releaseSha = scaP03OracleBoundReleaseSha256V2({
    query_set_id: set.query_set_id,
    release_id: set.release_id,
    query_set_sha256: set.query_set_sha256,
    queries: queries.map(({ query_id, script_id, script_content_sha256, binding, plan }) => ({
      query_id,
      script_id,
      script_sha256: script_content_sha256,
      binding,
      plan: validateScaP03QueryPlanV2(plan),
    })),
    oracle_ref: corpusRef,
    oracle: validateScaP03QualificationFixtureCorpusV2(corpus),
  });
  const cleanupRef = persist(
    { cleanup: "verified-by-host" },
    "sca-p03-cleanup-evidence",
    P03_BOOTSTRAP_ROLES.cleanup,
    [],
    null,
    P03_BOOTSTRAP_EVIDENCE_SCHEMAS.cleanup
  );
  const isolationRef = persist(
    { isolation: "verified-by-host" },
    "sca-p03-isolation-evidence",
    P03_BOOTSTRAP_ROLES.isolation,
    [],
    null,
    P03_BOOTSTRAP_EVIDENCE_SCHEMAS.isolation
  );
  const config: ScaP03DockerCandidateConfigV1 = {
    docker_executable: process.execPath,
    image_ref: `registry.example/joern@sha256:${"b".repeat(64)}`,
    expected_joern_version: "4.0.627",
    expected_docker_executable_sha256: sha256(readFileSync(process.execPath)),
    expected_docker_client_version: "1.0.0",
    expected_docker_server_version: "1.0.0",
    runtime_id: "runtime",
    isolation_id: "isolation",
    isolation_profile_sha256: profile.profile_sha256,
    implementation_identity_sha256: implementation.implementation_sha256,
    deployment_identity_sha256: sha256(
      canonicalJson({
        docker_executable_sha256: sha256(readFileSync(process.execPath)),
        docker_client_version: "1.0.0",
        docker_server_version: "1.0.0",
        image_id: `sha256:${"b".repeat(64)}`,
        joern_version: "4.0.627",
      })
    ),
    staging_parent: root,
    memory_bytes: 512 * 1024 * 1024,
    cpus: 1,
    pids: 128,
    max_workspace_bytes: 4 * 1024 * 1024,
    max_num_def: 100,
    max_command_output_bytes: 100_000,
    timeout_ms: 3000,
  };
  const policyRef = persist(
    {
      schema_id: "penny.sca-p03-runtime-policy.v1",
      schema_version: 1,
      policy_id: "policy",
      staging_parent_sha256: sha256(root),
      source_posture: "read_only",
      network_access: "denied",
      package_acquisition: "forbidden",
      target_execution: "forbidden",
      shell_execution: "forbidden",
      joern_server: "forbidden",
      process_timeout_ms: config.timeout_ms,
      max_graph_bytes: 1_048_576,
      max_query_output_bytes: 1_048_576,
      max_query_items: 100,
      max_page_items: 10,
      max_pages_per_query: 10,
      max_ast_depth: 8,
      max_ast_nodes: 32,
      max_num_def: config.max_num_def,
    },
    "sca-p03-runtime-policy"
  );
  const bindings = {
    evidence_class: "deterministic_test_only" as const,
    fixture_corpus_ref: corpusRef,
    source_oracle_ref: oracleRef,
    source_oracle_validation_ref: receiptRef,
    source_oracle_review_ref: reviewRef,
    parser_identity_sha256: oracle.parser.identity_sha256,
    baseline_query_set_ref: setRef,
    qualification_profile_ref: profileRef,
    runtime_policy_ref: policyRef,
    implementation_identity_ref: implementationRef,
    runtime_identity_ref: identityRef,
    cleanup_evidence_ref: cleanupRef,
    host_isolation_evidence_ref: isolationRef,
    fixture_content_refs: fixtureRefs,
    query_script_refs: queries.map((entry) => entry.script_ref),
    query_plan_refs: queries.map((entry) => entry.plan_ref),
    runtime_package_refs: [pkg],
    runtime_id: config.runtime_id,
    isolation_id: config.isolation_id,
    runtime_tree_sha256: "b".repeat(64),
    joern_version: config.expected_joern_version,
    max_num_def: config.max_num_def,
    implementation_identity_sha256: config.implementation_identity_sha256,
    deployment_identity_sha256: config.deployment_identity_sha256,
    profile_id: profile.profile_id,
    profile_sha256: profile.profile_sha256,
    release_id: "release",
    release_sha256: releaseSha,
    evaluated_at: stamp,
  };
  const candidate: ScaP03DockerCandidateV1 = {
    runtime_id: config.runtime_id,
    isolation_id: config.isolation_id,
    runtime_tree_sha256: "b".repeat(64),
    isolation_profile_sha256: config.isolation_profile_sha256,
    implementation_identity_sha256: config.implementation_identity_sha256,
    deployment_identity_sha256: config.deployment_identity_sha256,
    measured_joern_version: config.expected_joern_version,
    max_num_def: config.max_num_def,
    async qualify({ query_release, source_oracle_validation_ref }) {
      return {
        executed_query_release_sha256: query_release.release_sha256,
        cases: expected_cases.map((expected) => {
          const fixture = fixtures.find((item) => item.language === expected.language);
          if (fixture === undefined) throw new Error("fixture missing");
          const measured =
            reviewed &&
            (expected.query_id === "p03.control-guard.v2" ||
              expected.query_id === "p03.framework-dispatch.v2")
              ? projectSourceOracleCases(syntheticSourceOracle()).find(
                  (entry) => entry.case_id === expected.case_id
                )
              : expected;
          if (!measured) throw new Error("source case missing");
          const observation = observedFromSourceCase(
            measured,
            fixture,
            query_release.release_sha256,
            source_oracle_validation_ref
          );
          if (measured === expected) return observation;
          const blocker_code = "p03_oracle_assertion_mismatch" as const;
          return {
            ...observation,
            status: "blocked" as const,
            blocker_code,
            observed_sha256: scaP03QualificationObservationSha256V2({
              fixture_id: fixture.fixture_id,
              fixture_sha256: fixture.content_sha256,
              query_id: expected.query_id,
              frontend_language: observation.frontend_language,
              release_sha256: query_release.release_sha256,
              blocker_code,
              observations: observation.observations,
            }),
          };
        }),
      };
    },
  };
  const authority: ScaP03BootstrapHostAuthorityV1 = {
    reviewer_id: "reviewer",
    reviewer_authority_id: "test-authority",
    verifyReviewerReceipt: (review, bytes) =>
      Buffer.from(bytes).toString() ===
      canonicalJson({ record_sha256: review.record_ref.content_digest }),
    verifyCleanupEvidence: (_record, bytes) =>
      Buffer.from(bytes).toString() === canonicalJson({ cleanup: "verified-by-host" }),
    verifyIsolationEvidence: (_record, bytes) =>
      Buffer.from(bytes).toString() === canonicalJson({ isolation: "verified-by-host" }),
    isCurrentQualification: () => true,
    evidenceClass: () => "deterministic_test_only",
  };
  return { run_id, store, persist, config, bindings, fixtures, candidate, authority };
}

function sealed(value: Record<string, unknown>, key: string) {
  return { ...value, [key]: sha256(canonicalJson(value)) };
}

async function reviewedProof(
  fx: ReturnType<typeof testFixture>,
  times = { evaluated: stamp, reviewed: stamp, attested: stamp },
  recordOverride?: ScaP03BootstrapQualificationRecordV2
) {
  const record: ScaP03BootstrapQualificationRecordV2 =
    recordOverride ??
    (await evaluateScaP03BootstrapCandidateV2({
      run_id: fx.run_id,
      candidate: fx.candidate,
      store: fx.store,
      authority: fx.authority,
      bindings: { ...fx.bindings, evaluated_at: times.evaluated },
      fixtures: fx.fixtures,
      signal: new AbortController().signal,
    }));
  const recordRef = fx.persist(record, "sca-p03-bootstrap-record", P03_BOOTSTRAP_ROLES.evaluator, [
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
  ]);
  const receipt = fx.persist(
    { record_sha256: recordRef.content_digest },
    "sca-p03-reviewer-receipt",
    P03_BOOTSTRAP_ROLES.reviewer,
    [recordRef],
    null,
    P03_BOOTSTRAP_EVIDENCE_SCHEMAS.receipt
  );
  const reviewRef = fx.persist(
    sealed(
      {
        schema_id: SCA_P03_BOOTSTRAP_REVIEW_V2_SCHEMA,
        schema_version: 2,
        evidence_class: "deterministic_test_only",
        record_ref: recordRef,
        source_oracle_ref: record.source_oracle_ref,
        source_oracle_validation_ref: record.source_oracle_validation_ref,
        reviewer_id: "reviewer",
        reviewer_authority_id: "test-authority",
        reviewer_receipt_ref: receipt,
        decision: "PASS",
        reviewed_at: times.reviewed,
      },
      "review_sha256"
    ),
    "sca-p03-bootstrap-review",
    P03_BOOTSTRAP_ROLES.reviewer,
    [receipt, record.source_oracle_ref, record.source_oracle_validation_ref],
    null
  );
  const attestationRef = fx.persist(
    {
      schema_id: "penny.sca-p03-host-isolation-attestation.v1",
      schema_version: 1,
      attestation_id: "attestation",
      source_oracle_ref: record.source_oracle_ref,
      source_oracle_validation_ref: record.source_oracle_validation_ref,
      parser_identity_sha256: record.parser_identity_sha256,
      runtime_kind: "host_qualified_joern",
      runtime_id: "runtime",
      isolation_id: "isolation",
      runtime_tree_sha256: "b".repeat(64),
      implementation_identity_sha256: fx.config.implementation_identity_sha256,
      deployment_identity_sha256: fx.config.deployment_identity_sha256,
      profile_id: "profile",
      profile_sha256: fx.config.isolation_profile_sha256,
      qualification_scope: "live_qualified",
      qualified: true,
      attested_at: times.attested,
    },
    "sca-p03-host-isolation-attestation",
    SCA_P03_PRODUCTION_INPUT_CONTRACTS.host_attestation.producer,
    [recordRef, reviewRef, record.source_oracle_ref, record.source_oracle_validation_ref],
    null
  );
  const bindingRef = fx.persist(
    sealed(
      {
        schema_id: SCA_P03_ATTESTATION_BINDING_V2_SCHEMA,
        schema_version: 2,
        host_attestation_ref: attestationRef,
        qualification_record_ref: recordRef,
        review_ref: reviewRef,
        source_oracle_ref: record.source_oracle_ref,
        source_oracle_validation_ref: record.source_oracle_validation_ref,
        parser_identity_sha256: record.parser_identity_sha256,
      },
      "binding_sha256"
    ),
    "sca-p03-attestation-binding",
    P03_BOOTSTRAP_ROLES.attester,
    [
      recordRef,
      reviewRef,
      attestationRef,
      record.source_oracle_ref,
      record.source_oracle_validation_ref,
    ],
    null
  );
  const proof = {
    store: fx.store,
    authority: fx.authority,
    config: fx.config,
    binding_ref: bindingRef,
    host_attestation_ref: attestationRef,
    qualification_record_ref: recordRef,
    review_ref: reviewRef,
  };
  return { ...proof, record, receipt, recordRef, reviewRef, attestationRef, bindingRef };
}

const imageDigest = "b".repeat(64);
const image = `registry.example/joern@sha256:${imageDigest}`;
function testDockerRunner(
  calls: string[][],
  mode:
    | "normal"
    | "drift"
    | "missing"
    | "cleanup-fails"
    | "graph"
    | "bad-posture"
    | "joern-drift"
    | "extra-output"
    | "linked-output"
    | "workspace-full" = "normal",
  runtimeImageDigest = imageDigest
): DockerRunnerV1 {
  let name = "";
  let entrypoint = "";
  let running = false;
  let removed = false;
  let created: readonly string[] = [];
  return async ({ argv, signal }) => {
    if (signal.aborted) throw new Error("aborted");
    calls.push([...argv]);
    if (argv[0] === "version")
      return JSON.stringify({ Client: { Version: "1.0.0" }, Server: { Version: "1.0.0" } });
    if (argv[0] === "image")
      return JSON.stringify({
        Id: `sha256:${mode === "drift" ? "d".repeat(64) : runtimeImageDigest}`,
        RepoDigests: [image],
      });
    if (argv[0] !== "container") throw new Error("unexpected Docker call");
    if (argv[1] === "create") {
      created = argv;
      name = argv[argv.indexOf("--name") + 1] ?? "";
      entrypoint = argv[argv.indexOf("--entrypoint") + 1] ?? "";
      removed = false;
      running = false;
      return "e".repeat(64) + "\n";
    }
    if (argv[1] === "inspect") {
      const mounts = created
        .flatMap((arg, index) => (arg === "--mount" ? [created[index + 1] ?? ""] : []))
        .map((mount) => {
          const parts = mount.split(",");
          return {
            Type: "bind",
            Source: parts.find((part) => part.startsWith("src="))?.slice(4),
            Destination: parts.find((part) => part.startsWith("dst="))?.slice(4),
            RW: !parts.includes("readonly"),
          };
        });
      return JSON.stringify({
        Id: "e".repeat(64),
        Image: `sha256:${runtimeImageDigest}`,
        Name: `/${name}`,
        State: { Status: running ? "running" : "created", Running: running },
        Mounts: mounts,
        Config: {
          User: created[created.indexOf("--user") + 1],
          WorkingDir: "/tmp",
          Env: ["HOME=/tmp"],
          Entrypoint: ["sleep"],
          Cmd: created.slice(created.indexOf(image) + 1),
        },
        HostConfig: {
          NetworkMode: mode === "bad-posture" ? "bridge" : "none",
          ReadonlyRootfs: true,
          Init: true,
          Privileged: false,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          PidsLimit: 128,
          Memory: 512 * 1024 * 1024,
          MemorySwap: 512 * 1024 * 1024,
          NanoCpus: 1_000_000_000,
          LogConfig: { Type: "none" },
          Tmpfs: {
            "/tmp": "rw,exec,nosuid,nodev,size=67108864",
            "/work":
              created[created.indexOf("/tmp:rw,exec,nosuid,nodev,size=67108864") + 2]?.slice(6),
          },
        },
      });
    }
    if (argv[1] === "start") {
      running = true;
      return "";
    }
    if (argv[1] === "exec") {
      entrypoint = argv[3] ?? "";
      if (entrypoint === "find") {
        const pattern = argv[argv.indexOf("-name") + 1] ?? "";
        if (pattern === "io.joern.joern-cli-*.jar")
          return `io.joern.joern-cli-${mode === "joern-drift" ? "4.0.626" : "4.0.627"}.jar\n`;
        if (pattern === "io.joern.php2cpg-*.jar")
          return "io.joern.php2cpg-4.0.627-launcher.jar\nio.joern.php2cpg-4.0.627.jar\n";
        if (pattern === "io.joern.jssrc2cpg-*.jar")
          return "io.joern.jssrc2cpg-4.0.627.jar\nio.joern.jssrc2cpg-4.0.627-launcher.jar\n";
      }
      if (entrypoint === "which") return "/opt/joern/joern-cli/joern\n";
      if (entrypoint === "joern" && argv[4] === "--help")
        return "Usage: joern [options] [<cpg.bin>]\n\nScript execution\n";
      if (mode === "workspace-full") throw new Error("docker_container_exec_exit_1");
      if (entrypoint === "python3") {
        if (mode === "linked-output" || mode === "extra-output")
          throw new Error("docker_container_exec_exit_2");
        const data =
          argv[5] === "graph.cpg.bin"
            ? "real-cpg-output"
            : mode === "missing"
              ? "FILE\tL3NvdXJjZS9vdGhlci5waHA=\n"
              : mode === "graph"
                ? [
                    "FILE\tL3NvdXJjZS9zcmMvYS5waHA=",
                    ...["method", "call", "control_structure", "identifier"].map(
                      (kind, index) =>
                        `NODE\t${String(index + 1)}\t${Buffer.from(kind.toUpperCase()).toString("base64")}\t${Buffer.from("/source/src/a.php").toString("base64")}\t${Buffer.from(String(index + 1)).toString("base64")}\t${Buffer.from(kind).toString("base64")}\t\t`
                    ),
                    ...["call", "cfg", "reaching_def"].map(
                      (edge, index) =>
                        `EDGE\t1\t${String(index + 2)}\t${Buffer.from(edge.toUpperCase()).toString("base64")}`
                    ),
                  ].join("\n") + "\n"
                : "FILE\tL3NvdXJjZS9zcmMvYS5waHA=\n";
        return Buffer.from(argv[5] === "graph.cpg.bin" ? data : "META\tUEhQ\n" + data).toString(
          "base64"
        );
      }
      return "";
    }
    if (argv[1] === "rm") {
      if (mode === "cleanup-fails") throw new Error("daemon unreachable");
      removed = true;
      return name;
    }
    if (argv[1] === "ls") return removed ? "" : "e".repeat(12);
    throw new Error("unexpected Docker call");
  };
}

function hostOwnerDockerRunner(runtimeImageDigest = imageDigest): DockerRunnerV1 {
  const regressionBase = testDockerRunner([], "graph", runtimeImageDigest);
  let outputDirectory = "";
  let frontend = "PHP";
  return async (input) => {
    if (input.argv[0] === "container" && input.argv[1] === "create") {
      const mount = input.argv.find(
        (arg) => arg.startsWith("type=bind,src=") && arg.includes("dst=/input")
      );
      if (mount !== undefined)
        outputDirectory =
          mount
            .split(",")
            .find((part) => part.startsWith("src="))
            ?.slice(4) ?? "";
    }
    if (
      input.argv[0] === "container" &&
      input.argv[1] === "exec" &&
      input.argv[3] === "joern-parse"
    )
      frontend = input.argv[input.argv.indexOf("--language") + 1] ?? "PHP";
    const result = await regressionBase(input);
    if (input.argv[0] === "container" && input.argv[1] === "exec" && input.argv[3] === "python3") {
      if (input.argv[5] === "graph.cpg.bin")
        return Buffer.from(frontend === "PHP" ? "php-graph" : "js-graph").toString("base64");
      const graphPath = path.join(outputDirectory, "graph.cpg.bin");
      // Query operations have already staged exact bytes; build readback stages them too.
      frontend = readFileSync(graphPath).toString() === "js-graph" ? "JSSRC" : "PHP";
      return Buffer.from(
        Buffer.from(result, "base64")
          .toString()
          .replace("META\tUEhQ", "META\t" + Buffer.from(frontend).toString("base64")) +
          "FILE\t" +
          Buffer.from("/source/src/a.ts").toString("base64") +
          "\n"
      ).toString("base64");
    }
    return result;
  };
}

describe("P03 bootstrap authority boundary", () => {
  it("binds production proof lineage in a distinct self-digested record", () => {
    const fx = testFixture("production-record-contract");
    const draft = {
      schema_id: SCA_P03_PRODUCTION_QUALIFICATION_RECORD_V1_SCHEMA,
      schema_version: 1 as const,
      run_id: fx.run_id,
      production_bindings_sha256: "a".repeat(64),
      accepted_p01: {
        request_ref: fx.bindings.runtime_policy_ref,
        obligation_ledger_ref: fx.bindings.runtime_identity_ref,
        campaign_manifest_core_ref: fx.bindings.implementation_identity_ref,
        admission_evidence_ref: fx.bindings.qualification_profile_ref,
        p01_gate_ref: fx.bindings.fixture_corpus_ref,
        campaign_manifest_ref: fx.bindings.baseline_query_set_ref,
        frozen_refs: [fx.bindings.source_oracle_ref],
      },
      bootstrap_record_ref: fx.bindings.runtime_policy_ref,
      bootstrap_review_ref: fx.bindings.runtime_identity_ref,
      bootstrap_binding_ref: fx.bindings.implementation_identity_ref,
      host_attestation_ref: fx.bindings.qualification_profile_ref,
    };
    const record = validateScaP03ProductionQualificationRecordV1({
      ...draft,
      record_sha256: sha256(canonicalJson(draft)),
    });
    expect(record.accepted_p01).toEqual(draft.accepted_p01);
    const {
      evidence_class: _evidenceClass,
      cleanup_evidence_ref: _cleanupRef,
      host_isolation_evidence_ref: _isolationRef,
      evaluated_at: _evaluatedAt,
      ...frozenBase
    } = fx.bindings;
    void _evidenceClass;
    void _cleanupRef;
    void _isolationRef;
    void _evaluatedAt;
    const productionBindings = createScaP03FrozenProductionBindingsV1({
      run_id: fx.run_id,
      frozen: {
        ...frozenBase,
        implementation_source_refs: [fx.bindings.implementation_identity_ref],
      },
      roots: {
        accepted_p01: draft.accepted_p01,
        root_tool_id: "joern",
        toolchain_ref: fx.bindings.runtime_identity_ref,
        root_executable_ref: fx.bindings.runtime_policy_ref,
        root_measurement_ref: fx.bindings.implementation_identity_ref,
      },
    });
    expect(validateScaP03FrozenProductionBindingsV1(productionBindings)).toEqual(
      productionBindings
    );
    expect(() =>
      validateScaP03FrozenProductionBindingsV1({
        ...productionBindings,
        roots: { ...productionBindings.roots, root_tool_id: "substituted" },
      })
    ).toThrow("p03_production_bindings_invalid");
    expect(() =>
      validateScaP03ProductionQualificationRecordV1({
        ...record,
        production_bindings_sha256: "b".repeat(64),
      })
    ).toThrow();
    const duplicateDraft = {
      ...draft,
      bootstrap_review_ref: draft.bootstrap_record_ref,
    };
    expect(() =>
      validateScaP03ProductionQualificationRecordV1({
        ...duplicateDraft,
        record_sha256: sha256(canonicalJson(duplicateDraft)),
      })
    ).toThrow("p03_production_record_bootstrap_refs_invalid");
    fx.store.close();
  });

  it("keeps the reviewed real oracle BLOCKED on unresolved CFG and framework dispatch; no proof or attestation", async () => {
    const fx = testFixture("bootstrap-test", undefined, true);
    const record = await evaluateScaP03BootstrapCandidateV2({
      run_id: fx.run_id,
      candidate: fx.candidate,
      store: fx.store,
      authority: fx.authority,
      bindings: fx.bindings,
      fixtures: fx.fixtures,
      signal: new AbortController().signal,
    });
    expect(record.exact_expected_observations).toBe(false);
    expect(
      record.observations
        .filter(
          (entry) =>
            entry.query_id === "p03.control-guard.v2" ||
            entry.query_id === "p03.framework-dispatch.v2"
        )
        .every((entry) => entry.status === "blocked")
    ).toBe(true);
    expect(record.evidence_class).toBe("deterministic_test_only");
    fx.store.close();
  });
  it("constructs a test-only reviewed runtime after exact proof, fresh measurement and ordered timestamps; exercises graph and queries", async () => {
    const fx = testFixture();
    const proof = await reviewedProof(fx, {
      evaluated: "2026-09-23T12:00:00.000Z",
      reviewed: "2026-09-23T12:01:00.000Z",
      attested: "2026-09-23T12:02:00.000Z",
    });
    const { recordRef, receipt, attestationRef, bindingRef, reviewRef, record } = proof;
    let current = true;
    const authority = { ...fx.authority, isCurrentQualification: () => current };
    const input = {
      store: fx.store,
      authority,
      config: fx.config,
      binding_ref: bindingRef,
      host_attestation_ref: attestationRef,
      qualification_record_ref: recordRef,
      review_ref: reviewRef,
    };
    await expect(verifyScaP03BootstrapProofV2(input)).rejects.toThrow(
      "p03_bootstrap_v2_live_forbidden"
    );
    for (const staging_parent of [
      path.join(fx.config.staging_parent, "other"),
      `${fx.config.staging_parent}/.`,
    ]) {
      await expect(
        verifyScaP03DeterministicTestProofV2({
          ...input,
          config: { ...fx.config, staging_parent },
        })
      ).rejects.toThrow("p03_bootstrap_review_unqualified");
    }
    const calls: string[][] = [];
    const runtime = await createScaP03DockerDeterministicTestQualifiedRuntimeV1(
      fx.config,
      input,
      testDockerRunner(calls, "graph")
    );
    expect(calls.some((args) => args[0] === "image" && args[1] === "inspect")).toBe(true);
    expect(runtime.runtime_kind).toBe("simulated_joern_test_runtime");
    expect(runtime.qualification_scope).toBe("deterministic_test_only");
    expect(isVerifiedScaP03DockerHostRuntimeV1(runtime)).toBe(false);
    expect(runtime.runtime_id).toBe(fx.config.runtime_id);
    expect(record.exact_expected_observations).toBe(true);
    expect(Buffer.from(fx.store.read(receipt)).toString()).toBe(
      canonicalJson({ record_sha256: recordRef.content_digest })
    );
    const bytes = Buffer.from("<?php echo 1;");
    const sourceRef = fx.bindings.fixture_corpus_ref;
    const common = {
      schema_version: 1,
      tenant_id: "tenant",
      project_id: "project",
      run_id: "bootstrap-test",
      phase_id: "SCA-P03",
      p01_binding_sha256: digest("p01"),
      p02_binding_sha256: digest("p02"),
      p03_runtime_binding_sha256: digest("p03"),
      source_snapshot_ref: sourceRef,
      source_snapshot_sha256: sourceRef.content_digest,
      p03_request_ref: sourceRef,
      runtime_policy_ref: fx.bindings.runtime_policy_ref,
      joern_runtime_identity_ref: fx.bindings.runtime_identity_ref,
      isolation_evidence_ref: fx.bindings.host_isolation_evidence_ref,
      host_isolation_attestation_ref: attestationRef,
      implementation_identity_ref: fx.bindings.implementation_identity_ref,
      qualification_profile_ref: fx.bindings.qualification_profile_ref,
      baseline_query_set_ref: fx.bindings.baseline_query_set_ref,
      runtime_id: fx.config.runtime_id,
      runtime_kind: "host_qualified_joern",
      qualification_scope: "live_qualified",
      runtime_tree_sha256: "b".repeat(64),
      isolation_id: fx.config.isolation_id,
      isolation_profile_sha256: fx.config.isolation_profile_sha256,
    } as const;
    const graphRequest = validateScaP03OperationRequestV1(
      "build_source_graph",
      withScaP03Digest(
        {
          ...common,
          schema_id: "penny.sca-p03-graph-build-request.v1",
          operation_id: "sca-p03-build-source-graph-php",
          operation_kind: "build_source_graph",
          partition: "php",
          frontend_language: "PHP",
          source_file_manifest_ref: sourceRef,
          source_custody_ref: sourceRef,
          expected_files: [{ path: "src/a.php", content_sha256: sha256(bytes), role: "primary" }],
          max_num_def: fx.config.max_num_def,
          max_graph_bytes: 4096,
        },
        "request_sha256"
      )
    );
    const graph = await runtime.buildGraph({
      request: graphRequest,
      files: [{ path: "src/a.php", content_sha256: sha256(bytes), bytes, role: "primary" }],
      signal: new AbortController().signal,
    });
    expect(Buffer.from(graph.graph_bytes).toString()).toBe("real-cpg-output");
    expect(graph.accounted_files[0]?.disposition).toBe("parsed");
    const graphDigest = sha256(graph.graph_bytes);
    const queryRequest = validateScaP03OperationRequestV1(
      "run_baseline_query_batch",
      withScaP03Digest(
        {
          ...common,
          schema_id: "penny.sca-p03-baseline-query-batch-request.v2",
          schema_version: 2,
          operation_id: "sca-p03-baseline-query-batch-php",
          operation_kind: "run_baseline_query_batch",
          partition: "php",
          graph_component_ref: {
            ...sourceRef,
            content_digest: graphDigest,
            store_ref: `artifact://sha256/${graphDigest}`,
          },
          graph_component_sha256: graphDigest,
          graph_build_request_ref: sourceRef,
          graph_build_result_ref: sourceRef,
          ordered_query_ids: SCA_P03_QUERY_IDS,
          fidelity_requirements: [
            {
              requirement_id: "php-language",
              dimension: "language",
              subject: "php",
              partition: "php",
              materiality: "material",
              complement_evidence_ref: null,
            },
          ],
          query_script_refs: record.query_script_refs,
          query_plan_refs: record.query_plan_refs,
          max_query_output_bytes: 1000000,
          max_query_items: 100,
          max_page_items: 10,
          max_pages_per_query: 10,
        },
        "request_sha256"
      )
    );
    const result = await runtime.runBaselineQueries({
      request: queryRequest,
      graph_bytes: graph.graph_bytes,
      accounted_files: graph.accounted_files,
      query_release: readP03BootstrapInputs(fx.store, record, fx.run_id).release,
      signal: new AbortController().signal,
    });
    expect(result.executed_query_release_sha256).toBe(record.release_sha256);
    expect(result.pages.map((page) => page.query_id)).toEqual(SCA_P03_QUERY_IDS);
    // Even a direct request carrying live labels cannot promote the deterministic seam.
    expect(result.fidelity_observations).toEqual([
      {
        requirement_id: "php-language",
        support: "partial",
        reason_code: "joern_fidelity_unproven",
      },
    ]);
    const driftCalls: string[][] = [];
    const measuredRunner = testDockerRunner(driftCalls, "graph");
    await expect(
      createScaP03DockerDeterministicTestQualifiedRuntimeV1(fx.config, input, async (command) => {
        const response = await measuredRunner(command);
        if (command.argv[0] === "version") current = false;
        return response;
      })
    ).rejects.toThrow("p03_bootstrap_review_unqualified");
    expect(driftCalls.some((args) => args[0] === "image" && args[1] === "inspect")).toBe(true);
    current = true;
    expect(
      calls.filter((args) => args[0] === "image" && args[1] === "inspect").length
    ).toBeGreaterThanOrEqual(3);
    await expect(
      Reflect.apply(createScaP03DockerBootstrapDeterministicTestOnlyRuntimeV3, undefined, [
        fx.config,
        input,
        testDockerRunner([]),
      ])
    ).rejects.toThrow("p03_host_authority_invalid");
    current = false;
    await expect(
      runtime.buildGraph({
        request: graphRequest,
        files: [{ path: "src/a.php", content_sha256: sha256(bytes), bytes, role: "primary" }],
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("p03_bootstrap_review_unqualified");
    expect(calls.some((args) => args[1] === "rm")).toBe(true);
    fx.store.close();
  });
  it("rejects a consistent foreign-run frozen and evidence cohort in an otherwise valid local reviewed proof", async () => {
    const local = testFixture();
    const foreign = testFixture("foreign-run", local.store);
    const times = {
      evaluated: "2026-09-23T12:00:00.000Z",
      reviewed: "2026-09-23T12:01:00.000Z",
      attested: "2026-09-23T12:02:00.000Z",
    };
    const foreignProof = await reviewedProof(foreign, times);
    await expect(verifyScaP03DeterministicTestProofV2(foreignProof)).resolves.toMatchObject({
      attestation_id: "attestation",
    });
    const localProof = await reviewedProof(local, times, foreignProof.record);
    expect(localProof.bindingRef.run_id).toBe(local.run_id);
    expect(localProof.recordRef.run_id).toBe(local.run_id);
    expect(localProof.record.fixture_corpus_ref.run_id).toBe(foreign.run_id);
    expect(localProof.record.cleanup_evidence_ref.run_id).toBe(foreign.run_id);
    await expect(
      verifyScaP03DeterministicTestProofV2({ ...localProof, config: foreign.config })
    ).rejects.toThrow("p03_bootstrap_artifact_provenance_invalid");
    local.store.close();
  });

  it("rejects foreign-run inputs before evaluating a candidate against the trusted host run", async () => {
    const local = testFixture();
    const foreign = testFixture("foreign-run", local.store);
    await expect(
      evaluateScaP03BootstrapCandidateV2({
        run_id: foreign.run_id,
        candidate: foreign.candidate,
        store: foreign.store,
        authority: foreign.authority,
        bindings: foreign.bindings,
        fixtures: foreign.fixtures,
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ evidence_class: "deterministic_test_only" });
    await expect(
      evaluateScaP03BootstrapCandidateV2({
        run_id: local.run_id,
        candidate: foreign.candidate,
        store: foreign.store,
        authority: foreign.authority,
        bindings: foreign.bindings,
        fixtures: foreign.fixtures,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("p03_bootstrap_artifact_provenance_invalid");
    local.store.close();
  });

  it("rejects substituted frozen inputs, and wrong kind, schema, run, producer, upstream or parent at every proof role", async () => {
    const fx = testFixture();
    const { record, recordRef, reviewRef, attestationRef, bindingRef, receipt, ...proof } =
      await reviewedProof(fx, {
        evaluated: "2026-09-23T12:00:00.000Z",
        reviewed: "2026-09-23T12:01:00.000Z",
        attested: "2026-09-23T12:02:00.000Z",
      });
    const input = {
      ...proof,
      qualification_record_ref: recordRef,
      review_ref: reviewRef,
      host_attestation_ref: attestationRef,
      binding_ref: bindingRef,
    };
    await expect(verifyScaP03DeterministicTestProofV2(input)).resolves.toMatchObject({
      attestation_id: "attestation",
    });
    const substituted = fx.persist(
      JSON.parse(Buffer.from(fx.store.read(record.fixture_corpus_ref)).toString()),
      "sca-p03-qualification-profile",
      P03_BOOTSTRAP_ROLES.frozen,
      record.fixture_content_refs
    );
    expect(() =>
      readP03BootstrapInputs(fx.store, { ...record, fixture_corpus_ref: substituted }, fx.run_id)
    ).toThrow("p03_bootstrap_artifact_provenance_invalid");
    const refs = [
      recordRef,
      reviewRef,
      receipt,
      attestationRef,
      bindingRef,
      record.cleanup_evidence_ref,
      record.host_isolation_evidence_ref,
      record.fixture_corpus_ref,
      record.baseline_query_set_ref,
      record.qualification_profile_ref,
      record.runtime_policy_ref,
      record.implementation_identity_ref,
      record.runtime_identity_ref,
      ...record.fixture_content_refs,
      ...record.query_script_refs,
      ...record.query_plan_refs,
      ...record.runtime_package_refs,
    ];
    for (const ref of refs) {
      const metadata = fx.store.metadata(ref);
      if (metadata.content_schema === undefined) throw new Error("expected content schema");
      const mutations = [
        { ...metadata, kind: "other-kind" },
        { ...metadata, content_schema: { schema_id: "penny.sca-p03-wrong.v1", schema_version: 1 } },
        {
          ...metadata,
          content_schema: { schema_id: metadata.content_schema.schema_id, schema_version: 99 },
        },
        { ...metadata, producer: "host:untrusted" },
        { ...metadata, run_id: "other-run" },
        { ...metadata, phase: "SCA-P02" },
        { ...metadata, upstream_refs: [bindingRef] },
        { ...metadata, parent_ref: bindingRef },
      ];
      for (const altered of mutations) {
        const store = {
          read: (r: ArtifactRef) => fx.store.read(r),
          metadata: (r: ArtifactRef) =>
            r.artifact_id === ref.artifact_id ? altered : fx.store.metadata(r),
        };
        await expect(verifyScaP03DeterministicTestProofV2({ ...input, store })).rejects.toThrow(
          "p03_bootstrap_artifact_provenance_invalid"
        );
      }
    }
    const earlierReview = await reviewedProof(testFixture(), {
      evaluated: "2026-09-23T12:01:00.000Z",
      reviewed: "2026-09-23T12:00:00.000Z",
      attested: "2026-09-23T12:02:00.000Z",
    });
    await expect(verifyScaP03DeterministicTestProofV2(earlierReview)).rejects.toThrow(
      "p03_bootstrap_review_unqualified"
    );
    const earlierAttestation = await reviewedProof(testFixture(), {
      evaluated: "2026-09-23T12:00:00.000Z",
      reviewed: "2026-09-23T12:02:00.000Z",
      attested: "2026-09-23T12:01:00.000Z",
    });
    await expect(verifyScaP03DeterministicTestProofV2(earlierAttestation)).rejects.toThrow(
      "p03_bootstrap_review_unqualified"
    );
    fx.store.close();
    earlierReview.store.close();
    earlierAttestation.store.close();
  });

  it("evaluates exact ordered frozen observations but cannot promote synthetic evidence", async () => {
    const fx = testFixture();
    const record = await evaluateScaP03BootstrapCandidateV2({
      run_id: fx.run_id,
      candidate: fx.candidate,
      store: fx.store,
      authority: fx.authority,
      bindings: fx.bindings,
      fixtures: fx.fixtures,
      signal: new AbortController().signal,
    });
    expect(record.exact_expected_observations).toBe(true);
    expect(record.evidence_class).toBe("deterministic_test_only");
    expect(readP03BootstrapInputs(fx.store, record, fx.run_id).release.release_sha256).toBe(
      record.release_sha256
    );
    await expect(
      evaluateScaP03BootstrapCandidateV2({
        run_id: fx.run_id,
        candidate: fx.candidate,
        store: fx.store,
        authority: fx.authority,
        bindings: { ...fx.bindings, evidence_class: "live" },
        fixtures: fx.fixtures,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("p03_bootstrap_evidence_class_mismatch");
    await expect(
      evaluateScaP03BootstrapCandidateV2({
        run_id: fx.run_id,
        candidate: fx.candidate,
        store: fx.store,
        authority: fx.authority,
        bindings: { ...fx.bindings, release_sha256: digest("stale") },
        fixtures: fx.fixtures,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("p03_bootstrap_release_drift");
    await expect(
      evaluateScaP03BootstrapCandidateV2({
        run_id: fx.run_id,
        candidate: fx.candidate,
        store: fx.store,
        authority: fx.authority,
        bindings: { ...fx.bindings, profile_sha256: digest("drift") },
        fixtures: fx.fixtures,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("p03_bootstrap_frozen_input_mismatch");
    await expect(
      evaluateScaP03BootstrapCandidateV2({
        run_id: fx.run_id,
        candidate: { ...fx.candidate, runtime_id: "drift" },
        store: fx.store,
        authority: fx.authority,
        bindings: fx.bindings,
        fixtures: fx.fixtures,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("p03_bootstrap_candidate_identity_mismatch");
    await expect(
      evaluateScaP03BootstrapCandidateV2({
        run_id: fx.run_id,
        candidate: fx.candidate,
        store: fx.store,
        authority: fx.authority,
        bindings: { ...fx.bindings, fixture_corpus_ref: fx.bindings.qualification_profile_ref },
        fixtures: fx.fixtures,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow();
    const wrongCandidate: ScaP03DockerCandidateV1 = {
      ...fx.candidate,
      async qualify(input) {
        const output = await fx.candidate.qualify(input);
        return {
          ...output,
          cases: output.cases.map((entry, index) =>
            index === 0 ? { ...entry, observed_sha256: digest("wrong") } : entry
          ),
        };
      },
    };
    await expect(
      evaluateScaP03BootstrapCandidateV2({
        run_id: fx.run_id,
        candidate: wrongCandidate,
        store: fx.store,
        authority: fx.authority,
        bindings: fx.bindings,
        fixtures: fx.fixtures,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("qualification observations or digest diverge");
    await expect(
      evaluateScaP03BootstrapCandidateV2({
        run_id: fx.run_id,
        candidate: fx.candidate,
        store: fx.store,
        authority: { ...fx.authority, verifyCleanupEvidence: () => false },
        bindings: fx.bindings,
        fixtures: fx.fixtures,
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ cleanup_verified: false });
    fx.store.close();
  });

  it("refuses missing, substituted, stale, mismatched and non-live reviewed proof", async () => {
    const fx = testFixture();
    const proof = await reviewedProof(fx);
    const { recordRef, reviewRef } = proof;
    await expect(verifyScaP03BootstrapProofV2(proof)).rejects.toThrow(
      "p03_bootstrap_v2_live_forbidden"
    );
    const absent = { ...recordRef, artifact_id: `art_${"0".repeat(64)}` };
    await expect(
      verifyScaP03DeterministicTestProofV2({ ...proof, binding_ref: absent })
    ).rejects.toThrow();
    await expect(
      verifyScaP03DeterministicTestProofV2({ ...proof, review_ref: recordRef })
    ).rejects.toThrow("p03_bootstrap_binding_substituted");
    await expect(
      verifyScaP03DeterministicTestProofV2({ ...proof, host_attestation_ref: reviewRef })
    ).rejects.toThrow("p03_bootstrap_binding_substituted");
    await expect(
      verifyScaP03DeterministicTestProofV2({
        ...proof,
        authority: { ...fx.authority, isCurrentQualification: () => false },
      })
    ).rejects.toThrow("p03_bootstrap_review_unqualified");
    await expect(
      verifyScaP03DeterministicTestProofV2({
        ...proof,
        authority: { ...fx.authority, verifyCleanupEvidence: () => false },
      })
    ).rejects.toThrow("p03_bootstrap_review_unqualified");
    await expect(
      verifyScaP03DeterministicTestProofV2({
        ...proof,
        authority: { ...fx.authority, verifyIsolationEvidence: () => false },
      })
    ).rejects.toThrow("p03_bootstrap_review_unqualified");
    await expect(
      verifyScaP03DeterministicTestProofV2({
        ...proof,
        authority: { ...fx.authority, verifyReviewerReceipt: () => false },
      })
    ).rejects.toThrow("p03_bootstrap_review_unqualified");
    await expect(
      verifyScaP03DeterministicTestProofV2({
        ...proof,
        authority: { ...fx.authority, reviewer_id: "someone-else" },
      })
    ).rejects.toThrow("p03_bootstrap_review_unqualified");
    await expect(
      verifyScaP03DeterministicTestProofV2({
        ...proof,
        config: { ...fx.config, runtime_id: "other" },
      })
    ).rejects.toThrow("p03_bootstrap_review_unqualified");
    await expect(
      verifyScaP03DeterministicTestProofV2({
        ...proof,
        config: { ...fx.config, deployment_identity_sha256: digest("drift") },
      })
    ).rejects.toThrow("p03_bootstrap_review_unqualified");
    await expect(
      verifyScaP03DeterministicTestProofV2({
        ...proof,
        config: { ...fx.config, max_num_def: 101 },
      })
    ).rejects.toThrow("p03_bootstrap_review_unqualified");
    await expect(
      verifyScaP03DeterministicTestProofV2({
        ...proof,
        config: { ...fx.config, expected_joern_version: "4.0.628" },
      })
    ).rejects.toThrow("p03_bootstrap_review_unqualified");
    fx.store.close();
  });

  it("measures V3 once and drives the host-owner P03 uncertainty boundary, replay and fail-closed negatives", async () => {
    const fx = testFixture();
    const {
      evidence_class: _class,
      cleanup_evidence_ref: _cleanup,
      host_isolation_evidence_ref: _isolation,
      evaluated_at: _evaluated,
      ...legacyBindings
    } = fx.bindings;
    void [_class, _cleanup, _isolation, _evaluated];
    const sourceRef = fx.persist(
      { source: "exact" },
      "sca-p03-implementation-source",
      P03_BOOTSTRAP_ROLES.frozen,
      [],
      null,
      "penny.sca-p03-implementation-source.v1"
    );
    const implementationRef = fx.persist(
      JSON.parse(
        Buffer.from(fx.store.read(legacyBindings.implementation_identity_ref)).toString("utf8")
      ),
      "sca-p03-implementation-identity",
      SCA_P03_PRODUCTION_INPUT_CONTRACTS.implementation_identity.producer,
      [sourceRef]
    );
    const bindings = {
      ...legacyBindings,
      implementation_identity_ref: implementationRef,
      implementation_source_refs: [sourceRef],
    };
    const pkg = bindings.runtime_package_refs[0];
    if (pkg === undefined) throw new Error("package missing");
    const implementation_refs = bindings.implementation_source_refs;
    const packageClosure = sha256(
      canonicalJson([{ ref: pkg, current_sha256: sha256(fx.store.read(pkg)) }])
    );
    const identity = {
      runtime_id: bindings.runtime_id,
      isolation_id: bindings.isolation_id,
      implementation_sha256: bindings.implementation_identity_sha256,
      runtime_package_sha256: packageClosure,
      deployment_sha256: bindings.deployment_identity_sha256,
      docker_executable_sha256: digest("docker"),
      docker_client_version: "1.0.0",
      docker_server_version: "1.0.0",
      image_id: `sha256:${bindings.runtime_tree_sha256}`,
      joern_version: bindings.joern_version,
    };
    const workspace_registry = ScaP03WorkspaceRegistryV1.inProcess();
    let drift = false;
    let selectionBytes = Buffer.from("{}");
    const selectionQueue: Buffer[] = [];
    const probe: ScaP03BootstrapHostProbeV1 = {
      containerCensus: async () => [],
      inspectContainer: async () => Buffer.from("{}"),
      measureIdentity: async () => identity,
      readBuildFile: async (ref) => (drift ? Buffer.from("drift") : fx.store.read(ref)),
      workspacePaths: async (attemptId) => workspace_registry.paths(attemptId),
      workspaceIdentityDigest: async (attemptId) => workspace_registry.digest(attemptId),
      currentSelection: async () => selectionQueue.shift() ?? selectionBytes,
      now: () => new Date(Date.now() + 5_000),
    };
    let count = 0;
    const invalidBindings = { ...bindings, cleanup_evidence_ref: fx.bindings.cleanup_evidence_ref };
    await expect(
      measureScaP03BootstrapCandidateV3({
        run_id: fx.run_id,
        bindings: invalidBindings,
        store: fx.store,
        probe,
        implementation_refs,
        workspace_registry,
        signal: new AbortController().signal,
        candidate: async () => {
          count++;
          return fx.candidate;
        },
      })
    ).rejects.toThrow("p03_bootstrap_frozen_bindings_invalid");
    expect(count).toBe(0);
    const name = "penny-p03-00000000-0000-4000-8000-000000000001";
    const id = digest("container");
    const projection = canonicalJson({
      image: identity.image_id,
      id,
      name: `/${name}`,
      network: "none",
      pid_mode: "",
      ipc_mode: "",
      uts_mode: "",
      readonly_root: true,
      privileged: false,
      init: true,
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges"],
      pids: fx.config.pids,
      memory: fx.config.memory_bytes,
      memory_swap: fx.config.memory_bytes,
      nano_cpus: Math.round(fx.config.cpus * 1_000_000_000),
      log: "none",
      tmpfs: {
        "/tmp": "rw,exec,nosuid,nodev,size=67108864",
        "/work": `rw,exec,nosuid,nodev,size=${String(fx.config.max_workspace_bytes)},mode=0700,uid=${String(process.getuid?.())},gid=${String(process.getgid?.())}`,
      },
      user: `${String(process.getuid?.())}:${String(process.getgid?.())}`,
      workdir: "/tmp",
      env: ["HOME=/tmp"],
      entrypoint: ["sleep"],
      command: ["infinity"],
      running: true,
      mounts: [
        { destination: "/scripts", type: "bind", readonly: true, source_sha256: digest("scripts") },
      ],
    });
    const capture = (sink: ScaP03HostWitnessSinkV1) => {
      const work = path.join(roots.at(-1) ?? "", "workspace");
      mkdirSync(work);
      const stat = lstatSync(work);
      sink.startWorkspace(canonicalJson({ path: work, dev: stat.dev, ino: stat.ino }));
      rmSync(work, { recursive: true });
      sink.create(name, ["container", "create"]);
      sink.id(name, id);
      sink.inspect(name, '{"inspect":true}', projection);
      sink.startContainer(name);
      sink.command(name, ["container", "exec"], true);
      sink.response(name, "ok");
      sink.readback(name, Buffer.from("graph"));
      sink.removal(name, true);
      sink.finishWorkspace(true);
    };
    const measured = await measureScaP03BootstrapCandidateV3({
      run_id: fx.run_id,
      bindings,
      store: fx.store,
      probe,
      implementation_refs,
      workspace_registry,
      signal: new AbortController().signal,
      candidate: async (sink) => ({
        ...fx.candidate,
        qualify: async (input) => {
          count++;
          capture(sink);
          return fx.candidate.qualify(input);
        },
      }),
    });
    expect(count).toBe(1);
    expect(measured.disposition).toBe("completed");
    await expect(
      measureScaP03BootstrapCandidateV3({
        run_id: fx.run_id,
        bindings,
        store: fx.store,
        probe,
        implementation_refs: [],
        workspace_registry,
        signal: new AbortController().signal,
        candidate: async () => fx.candidate,
      })
    ).rejects.toThrow("p03_bootstrap_implementation_refs_unbound");
    const mismatched = await measureScaP03BootstrapCandidateV3({
      run_id: fx.run_id,
      bindings,
      store: fx.store,
      probe: { ...probe, workspaceIdentityDigest: async () => digest("unregistered") },
      implementation_refs,
      workspace_registry,
      signal: new AbortController().signal,
      candidate: async (sink) => ({
        ...fx.candidate,
        qualify: async (request) => {
          capture(sink);
          return fx.candidate.qualify(request);
        },
      }),
    });
    expect(mismatched.disposition).toBe("failed");
    expect(validateScaP03AttemptWitnessV1(mismatched.witness_bytes).disposition).toBe("failed");
    const witness: unknown = JSON.parse(Buffer.from(measured.witness_bytes).toString());
    const attempt_ref = fx.persist(
      witness,
      "sca-p03-attempt-witness",
      P03_BOOTSTRAP_ROLES.evaluator,
      [
        bindings.runtime_policy_ref,
        bindings.implementation_identity_ref,
        bindings.runtime_identity_ref,
        ...bindings.implementation_source_refs,
      ]
    );
    const seal = (body: Record<string, unknown>) => ({
      ...body,
      evidence_sha256: sha256(canonicalJson(body)),
    });
    const observed_at = new Date().toISOString();
    const cleanup = seal({
      schema_id: SCA_P03_CLEANUP_EVIDENCE_V2_SCHEMA,
      schema_version: 2,
      attempt_ref,
      record_input_sha256: sha256(
        canonicalJson({
          attempt_ref,
          runtime_policy_ref: bindings.runtime_policy_ref,
          implementation_identity_ref: bindings.implementation_identity_ref,
          runtime_identity_ref: bindings.runtime_identity_ref,
          implementation_source_refs: bindings.implementation_source_refs,
        })
      ),
      verifier_id: "cleanup-verifier",
      observed_at,
      containers: [{ name, id, absent: true }],
      workspace_absent_or_empty: true,
      complete_census: true,
      decision: "PASS",
    });
    const isolation = seal({
      schema_id: SCA_P03_ISOLATION_EVIDENCE_V2_SCHEMA,
      schema_version: 2,
      attempt_ref,
      policy_ref: bindings.runtime_policy_ref,
      verifier_id: "isolation-verifier",
      observed_at,
      identity,
      containers: [{ name, id, confinement_sha256: sha256(projection) }],
      decision: "PASS",
    });
    const cleanup_ref = fx.persist(
      cleanup,
      "sca-p03-cleanup-evidence",
      P03_BOOTSTRAP_ROLES.cleanup,
      [attempt_ref, bindings.runtime_policy_ref]
    );
    const isolation_ref = fx.persist(
      isolation,
      "sca-p03-isolation-evidence",
      P03_BOOTSTRAP_ROLES.isolation,
      [attempt_ref, bindings.runtime_policy_ref]
    );
    const input = {
      run_id: fx.run_id,
      bindings,
      measured,
      attempt_ref,
      cleanup_ref,
      isolation_ref,
      implementation_refs,
      store: fx.store,
      probe,
    };
    const record = await finalizeScaP03BootstrapRecordV3(input);
    expect(record.observations).toHaveLength(21);
    expect(record.evidence_class).toBe("live");
    await expect(
      finalizeScaP03BootstrapRecordV3({ ...input, implementation_refs: [] })
    ).rejects.toThrow("p03_bootstrap_implementation_refs_unbound");
    await expect(
      finalizeScaP03BootstrapRecordV3({ ...input, attempt_ref: fx.bindings.cleanup_evidence_ref })
    ).rejects.toThrow();
    const failedCleanup = fx.persist(
      seal(
        Object.fromEntries(
          Object.entries({ ...cleanup, decision: "FAIL" }).filter(
            ([key]) => key !== "evidence_sha256"
          )
        )
      ),
      "sca-p03-cleanup-evidence",
      P03_BOOTSTRAP_ROLES.cleanup,
      [attempt_ref, bindings.runtime_policy_ref]
    );
    await expect(
      finalizeScaP03BootstrapRecordV3({ ...input, cleanup_ref: failedCleanup })
    ).rejects.toThrow();
    const failedIsolation = fx.persist(
      seal(
        Object.fromEntries(
          Object.entries({ ...isolation, decision: "FAIL" }).filter(
            ([key]) => key !== "evidence_sha256"
          )
        )
      ),
      "sca-p03-isolation-evidence",
      P03_BOOTSTRAP_ROLES.isolation,
      [attempt_ref, bindings.runtime_policy_ref]
    );
    await expect(
      finalizeScaP03BootstrapRecordV3({ ...input, isolation_ref: failedIsolation })
    ).rejects.toThrow();
    drift = true;
    await expect(finalizeScaP03BootstrapRecordV3(input)).rejects.toThrow("p03_host_build_drift");
    drift = false;
    const record_ref = fx.persist(
      record,
      "sca-p03-bootstrap-record",
      P03_BOOTSTRAP_ROLES.evaluator,
      [
        bindings.fixture_corpus_ref,
        bindings.source_oracle_ref,
        bindings.source_oracle_validation_ref,
        bindings.source_oracle_review_ref,
        bindings.baseline_query_set_ref,
        bindings.qualification_profile_ref,
        bindings.runtime_policy_ref,
        bindings.implementation_identity_ref,
        bindings.runtime_identity_ref,
        ...bindings.fixture_content_refs,
        ...bindings.query_script_refs,
        ...bindings.query_plan_refs,
        ...bindings.runtime_package_refs,
        ...bindings.implementation_source_refs,
        attempt_ref,
        cleanup_ref,
        isolation_ref,
      ]
    );
    const reviewed_at = new Date(Date.parse(record.evaluated_at) + 1000).toISOString();
    const signed = {
      external_review_id: "external-review",
      record_ref,
      attempt_ref,
      cleanup_ref,
      isolation_ref,
      reviewer_id: "reviewer",
      reviewer_authority_id: "review-authority",
      decision: "PASS",
      reviewed_at,
    };
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const external_review_ref = fx.persist(
      {
        ...signed,
        signature: sign(null, Buffer.from(canonicalJson(signed)), privateKey).toString("base64"),
      },
      "sca-p03-external-review",
      P03_BOOTSTRAP_ROLES.reviewer,
      [record_ref, attempt_ref, cleanup_ref, isolation_ref],
      null,
      "penny.sca-p03-external-review.v1"
    );
    const receiptBody = {
      schema_id: "penny.sca-p03-bootstrap-reviewer-receipt.v2",
      schema_version: 2,
      external_review_id: signed.external_review_id,
      external_review_ref,
      record_ref,
      attempt_ref,
      cleanup_ref,
      isolation_ref,
      reviewer_id: signed.reviewer_id,
      reviewer_authority_id: signed.reviewer_authority_id,
      evaluator_id: "evaluator",
      attester_id: "attester",
      reviewed_at,
      decision: "PASS",
    };
    const receipt_ref = fx.persist(
      { ...receiptBody, receipt_sha256: sha256(canonicalJson(receiptBody)) },
      "sca-p03-reviewer-receipt",
      P03_BOOTSTRAP_ROLES.reviewer,
      [record_ref, attempt_ref, cleanup_ref, isolation_ref, external_review_ref]
    );
    const reviewBody = {
      schema_id: "penny.sca-p03-bootstrap-review.v3",
      schema_version: 3,
      evidence_class: "live",
      record_ref,
      source_oracle_ref: bindings.source_oracle_ref,
      source_oracle_validation_ref: bindings.source_oracle_validation_ref,
      attempt_witness_ref: attempt_ref,
      implementation_source_refs: bindings.implementation_source_refs,
      reviewer_id: signed.reviewer_id,
      reviewer_authority_id: signed.reviewer_authority_id,
      reviewer_receipt_ref: receipt_ref,
      decision: "PASS",
      reviewed_at,
    };
    const review_ref = fx.persist(
      { ...reviewBody, review_sha256: sha256(canonicalJson(reviewBody)) },
      "sca-p03-bootstrap-review",
      P03_BOOTSTRAP_ROLES.reviewer,
      [
        receipt_ref,
        bindings.source_oracle_ref,
        bindings.source_oracle_validation_ref,
        attempt_ref,
        ...bindings.implementation_source_refs,
      ]
    );
    const attestation = {
      schema_id: "penny.sca-p03-host-isolation-attestation.v1",
      schema_version: 1,
      attestation_id: "attestation-v3",
      source_oracle_ref: bindings.source_oracle_ref,
      source_oracle_validation_ref: bindings.source_oracle_validation_ref,
      parser_identity_sha256: bindings.parser_identity_sha256,
      runtime_kind: "host_qualified_joern",
      runtime_id: bindings.runtime_id,
      isolation_id: bindings.isolation_id,
      implementation_identity_sha256: bindings.implementation_identity_sha256,
      deployment_identity_sha256: bindings.deployment_identity_sha256,
      profile_id: bindings.profile_id,
      profile_sha256: bindings.profile_sha256,
      runtime_tree_sha256: bindings.runtime_tree_sha256,
      qualification_scope: "live_qualified",
      qualified: true,
      attested_at: new Date(Date.parse(reviewed_at) + 1000).toISOString(),
    };
    const host_attestation_ref = fx.persist(
      attestation,
      "sca-p03-host-isolation-attestation",
      SCA_P03_PRODUCTION_INPUT_CONTRACTS.host_attestation.producer,
      [
        record_ref,
        review_ref,
        bindings.source_oracle_ref,
        bindings.source_oracle_validation_ref,
        attempt_ref,
        ...bindings.implementation_source_refs,
      ]
    );
    const bindingBody = {
      schema_id: "penny.sca-p03-attestation-binding.v3",
      schema_version: 3,
      host_attestation_ref,
      qualification_record_ref: record_ref,
      review_ref,
      source_oracle_ref: bindings.source_oracle_ref,
      source_oracle_validation_ref: bindings.source_oracle_validation_ref,
      parser_identity_sha256: bindings.parser_identity_sha256,
      attempt_witness_ref: attempt_ref,
      implementation_source_refs: bindings.implementation_source_refs,
    };
    const binding_ref = fx.persist(
      { ...bindingBody, binding_sha256: sha256(canonicalJson(bindingBody)) },
      "sca-p03-attestation-binding",
      P03_BOOTSTRAP_ROLES.attester,
      [
        record_ref,
        review_ref,
        host_attestation_ref,
        bindings.source_oracle_ref,
        bindings.source_oracle_validation_ref,
        attempt_ref,
        ...bindings.implementation_source_refs,
      ]
    );
    const selectionBody = {
      schema_id: "penny.sca-p03-bootstrap-selection.v1",
      schema_version: 1,
      record_ref,
      binding_ref,
      deployment_sha256: bindings.deployment_identity_sha256,
      selected_at: new Date(Date.parse(attestation.attested_at) + 1000).toISOString(),
      status: "selected",
    };
    selectionBytes = Buffer.from(
      canonicalJson({ ...selectionBody, selection_sha256: sha256(canonicalJson(selectionBody)) })
    );
    const authority = createScaP03BootstrapHostAuthorityV1({
      store: fx.store,
      probe,
      record_ref,
      binding_ref,
      attempt_ref,
      cleanup_ref,
      isolation_ref,
      receipt_ref,
      reviewer_public_key: publicKey,
      reviewer_id: "reviewer",
      reviewer_authority_id: "review-authority",
      evaluator_id: "evaluator",
      attester_id: "attester",
      implementation_refs,
      runtime_package_refs: [pkg],
    });
    const proof = {
      authority,
      config: fx.config,
      binding_ref,
      host_attestation_ref,
      qualification_record_ref: record_ref,
      review_ref,
    };
    const verified = await verifyScaP03BootstrapProofV3(proof);
    for (const staging_parent of [
      path.join(fx.config.staging_parent, "other"),
      `${fx.config.staging_parent}/.`,
    ]) {
      const changedConfig = { ...fx.config, staging_parent };
      await expect(
        verifyScaP03BootstrapProofV3({ ...proof, config: changedConfig })
      ).rejects.toThrow("p03_host_config_or_proof_mismatch");
      const commands: string[][] = [];
      await expect(
        createScaP03DockerBootstrapDeterministicTestOnlyRuntimeV3(
          changedConfig,
          proof,
          testDockerRunner(commands)
        )
      ).rejects.toThrow("p03_host_config_or_proof_mismatch");
      expect(commands).toEqual([]);
    }
    await expect(
      verifyScaP03BootstrapProofV3({
        ...proof,
        authority: createScaP03BootstrapHostAuthorityV1({
          store: fx.store,
          probe,
          record_ref,
          binding_ref,
          attempt_ref,
          cleanup_ref,
          isolation_ref,
          receipt_ref,
          reviewer_public_key: publicKey,
          reviewer_id: "reviewer",
          reviewer_authority_id: "review-authority",
          evaluator_id: "evaluator",
          attester_id: "attester",
          implementation_refs: [],
          runtime_package_refs: [pkg],
        }),
      })
    ).rejects.toThrow("p03_host_build_drift");
    const badKey = generateKeyPairSync("ed25519").publicKey;
    await expect(
      verifyScaP03BootstrapProofV3({
        ...proof,
        authority: createScaP03BootstrapHostAuthorityV1({
          store: fx.store,
          probe,
          record_ref,
          binding_ref,
          attempt_ref,
          cleanup_ref,
          isolation_ref,
          receipt_ref,
          reviewer_public_key: badKey,
          reviewer_id: "reviewer",
          reviewer_authority_id: "review-authority",
          evaluator_id: "evaluator",
          attester_id: "attester",
          implementation_refs,
          runtime_package_refs: [pkg],
        }),
      })
    ).rejects.toThrow("p03_host_review_untrusted");
    await expect(
      Reflect.apply(verifyScaP03BootstrapProofV3, undefined, [
        { ...proof, authority: { verifyLiveV3: () => Promise.resolve(verified) } },
      ])
    ).rejects.toThrow("p03_host_authority_invalid");
    await expect(
      verifyScaP03BootstrapProofV3({
        ...proof,
        qualification_record_ref: bindings.fixture_corpus_ref,
      })
    ).rejects.toThrow("p03_host_config_or_proof_mismatch");
    drift = true;
    await expect(verifyScaP03BootstrapProofV3(proof)).rejects.toThrow("p03_host_build_drift");
    drift = false;
    expect(verified.attestation_id).toBe("attestation-v3");
    expect(verified.source_oracle_ref).toEqual(bindings.source_oracle_ref);
    const runtime = await createScaP03DockerBootstrapDeterministicTestOnlyRuntimeV3(
      fx.config,
      proof,
      testDockerRunner([])
    );
    expect(isVerifiedScaP03DockerHostRuntimeV1(runtime)).toBe(false);
    const graphBytes = Buffer.from("real-cpg-output");
    const graphSha256 = sha256(graphBytes);
    const graphRef = {
      ...bindings.fixture_corpus_ref,
      content_digest: graphSha256,
      store_ref: `artifact://sha256/${graphSha256}`,
    };
    const requirements = validateScaP03QualificationProfileV2(
      JSON.parse(Buffer.from(fx.store.read(bindings.qualification_profile_ref)).toString())
    ).fidelity_requirements.filter((entry) => entry.partition === "php");
    const queryRequest = validateScaP03OperationRequestV1(
      "run_baseline_query_batch",
      withScaP03Digest(
        {
          schema_id: "penny.sca-p03-baseline-query-batch-request.v2",
          schema_version: 2,
          tenant_id: "tenant",
          project_id: "project",
          run_id: fx.run_id,
          phase_id: "SCA-P03",
          operation_id: "sca-p03-baseline-query-batch-php",
          operation_kind: "run_baseline_query_batch",
          p01_binding_sha256: digest("p01"),
          p02_binding_sha256: digest("p02"),
          p03_runtime_binding_sha256: digest("p03"),
          source_snapshot_ref: bindings.fixture_corpus_ref,
          source_snapshot_sha256: bindings.fixture_corpus_ref.content_digest,
          p03_request_ref: bindings.fixture_corpus_ref,
          runtime_policy_ref: bindings.runtime_policy_ref,
          joern_runtime_identity_ref: bindings.runtime_identity_ref,
          isolation_evidence_ref: isolation_ref,
          host_isolation_attestation_ref: null,
          implementation_identity_ref: bindings.implementation_identity_ref,
          qualification_profile_ref: bindings.qualification_profile_ref,
          baseline_query_set_ref: bindings.baseline_query_set_ref,
          runtime_id: fx.config.runtime_id,
          runtime_kind: "simulated_joern_test_runtime",
          qualification_scope: "deterministic_test_only",
          runtime_tree_sha256: bindings.runtime_tree_sha256,
          isolation_id: fx.config.isolation_id,
          isolation_profile_sha256: fx.config.isolation_profile_sha256,
          partition: "php",
          graph_component_ref: graphRef,
          graph_component_sha256: graphSha256,
          graph_build_request_ref: bindings.fixture_corpus_ref,
          graph_build_result_ref: bindings.fixture_corpus_ref,
          ordered_query_ids: SCA_P03_QUERY_IDS,
          fidelity_requirements: requirements,
          query_script_refs: bindings.query_script_refs,
          query_plan_refs: bindings.query_plan_refs,
          max_query_output_bytes: 1_000_000,
          max_query_items: 100,
          max_page_items: 10,
          max_pages_per_query: 10,
        },
        "request_sha256"
      )
    );
    const queryInput = {
      request: queryRequest,
      query_release: readP03BootstrapInputs(fx.store, record, fx.run_id).release,
      graph_bytes: graphBytes,
      accounted_files: [
        {
          path: "src/a.php",
          content_sha256: digest("source"),
          disposition: "parsed" as const,
          reason_code: null,
        },
      ],
      signal: new AbortController().signal,
    };
    const mutableConfig = { ...fx.config };
    const driftCommands: string[][] = [];
    const driftingRuntime = await createScaP03DockerBootstrapDeterministicTestOnlyRuntimeV3(
      mutableConfig,
      proof,
      testDockerRunner(driftCommands)
    );
    const beforeDrift = driftCommands.length;
    mutableConfig.staging_parent = `${fx.config.staging_parent}/.`;
    await expect(driftingRuntime.runBaselineQueries(queryInput)).rejects.toThrow(
      "p03_host_config_or_proof_mismatch"
    );
    for (const method of [driftingRuntime.qualify, driftingRuntime.buildGraph]) {
      await expect(Reflect.apply(method, driftingRuntime, [{}])).rejects.toThrow(
        "p03_host_config_or_proof_mismatch"
      );
    }
    expect(driftCommands).toHaveLength(beforeDrift);
    const queried = await runtime.runBaselineQueries(queryInput);
    expect(
      queried.pages.find((page) => page.query_id === "p03.unsupported-surface.v2")?.items
    ).toEqual([]);
    expect(queried.fidelity_observations).toEqual(
      requirements.map((requirement) => ({
        requirement_id: requirement.requirement_id,
        support: "supported",
        reason_code: null,
      }))
    );
    const derivation = {
      requirements,
      observations: queried.fidelity_observations,
      qualification_scope: runtime.qualification_scope,
      graph_component_refs: { php: graphRef, javascript_typescript: undefined },
      evidence_refs: { php: [proof.qualification_record_ref], javascript_typescript: [] },
      qualified_complement_requirement_ids: new Set<string>(),
    };
    expect(deriveScaP03GraphSupportEntriesV1(derivation).some((entry) => entry.material_gap)).toBe(
      true
    );
    const unsupportedRuntime = await createScaP03DockerBootstrapDeterministicTestOnlyRuntimeV3(
      fx.config,
      proof,
      testDockerRunner([], "graph")
    );
    const unsupported = await unsupportedRuntime.runBaselineQueries(queryInput);
    expect(
      unsupported.pages.find((page) => page.query_id === "p03.unsupported-surface.v2")?.items.length
    ).toBeGreaterThan(0);
    const unresolved = unsupported.pages.find(
      (page) => page.query_id === "p03.unsupported-surface.v2"
    )?.items;
    expect(unresolved).toBeDefined();
    expect(
      unresolved?.every(
        (item) =>
          item.disposition === "unresolved" &&
          item.reason_code === "relationship_unproven" &&
          item.claim === "unsupported_surface"
      )
    ).toBe(true);
    expect(unsupported.fidelity_observations).toEqual(queried.fidelity_observations);
    expect(
      deriveScaP03GraphSupportEntriesV1({
        ...derivation,
        observations: unsupported.fidelity_observations,
      })
        .filter((entry) => entry.dimension === "surface" && entry.materiality === "material")
        .every((entry) => entry.material_gap)
    ).toBe(true);
    for (const changedRequest of [
      { ...queryRequest, qualification_profile_ref: bindings.fixture_corpus_ref },
      { ...queryRequest, implementation_identity_ref: bindings.fixture_corpus_ref },
      { ...queryRequest, fidelity_requirements: requirements.slice(1) },
      {
        ...queryRequest,
        runtime_kind: "host_qualified_joern" as const,
        qualification_scope: "live_qualified" as const,
      },
    ]) {
      await expect(
        unsupportedRuntime.runBaselineQueries({ ...queryInput, request: changedRequest })
      ).rejects.toThrow("p03_fidelity_binding_mismatch");
    }
    // Synthetic Docker/probe/qualification fixtures; actual guarded runtime query path,
    // service adapters, host owner, P03 finalization and operational replay (no activation).
    const regressionRuntime = await createScaP03DockerBootstrapDeterministicTestOnlyRuntimeV3(
      fx.config,
      proof,
      hostOwnerDockerRunner()
    );
    // Qualification observations are fixture-injected, not a claim of live Docker qualification.
    regressionRuntime.qualify = (value) => fx.candidate.qualify(value);
    await p03HostOwnerRegression({
      store: fx.store,
      runtime: regressionRuntime,
      record,
      attestation_ref: host_attestation_ref,
    });
    const swappedBody = {
      ...selectionBody,
      selected_at: new Date(Date.parse(selectionBody.selected_at) + 1000).toISOString(),
    };
    const swapped = Buffer.from(
      canonicalJson({ ...swappedBody, selection_sha256: sha256(canonicalJson(swappedBody)) })
    );
    selectionQueue.push(selectionBytes, swapped);
    await expect(
      createScaP03DockerBootstrapDeterministicTestOnlyRuntimeV3(
        fx.config,
        proof,
        testDockerRunner([])
      )
    ).rejects.toThrow("p03_bootstrap_proof_drift");
    const revoked = Buffer.from(
      canonicalJson({
        ...selectionBody,
        status: "revoked",
        selection_sha256: sha256(canonicalJson({ ...selectionBody, status: "revoked" })),
      })
    );
    selectionQueue.push(selectionBytes, revoked);
    await expect(
      createScaP03DockerBootstrapDeterministicTestOnlyRuntimeV3(
        fx.config,
        proof,
        testDockerRunner([])
      )
    ).rejects.toThrow("p03_host_lineage_invalid");
    selectionBytes = revoked;
    await expect(runtime.runBaselineQueries(queryInput)).rejects.toThrow(
      "p03_host_lineage_invalid"
    );
    await expect(verifyScaP03BootstrapProofV3(proof)).rejects.toThrow("p03_host_lineage_invalid");
    await expect(
      Reflect.apply(runtime.buildGraph, runtime, [
        { files: [], signal: new AbortController().signal },
      ])
    ).rejects.toThrow("p03_host_lineage_invalid");
    expect(
      (await readdir(fx.config.staging_parent)).filter((name) => name.startsWith("p03-"))
    ).toEqual([]);
    fx.store.close();
  }, 60_000);
  it("fresh freeze/seal/verify imports exact production inputs unchanged through the host owner and verified runtime, rejecting substitutions", async () => {
    const fx = testFixture("freeze-run", undefined, true);
    const { oracle, fixtures } = await readSourceOracle();
    const oracleBytes = Buffer.from(canonicalJson(oracle));
    const oracleRef = previewArtifactRef({
      metadata: {
        schema_version: 2,
        run_id: fx.run_id,
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
      content: oracleBytes,
    });
    const sourceBytes = ["source", "build", "normalizer", "query_runner"].map((x) =>
      Buffer.from(x)
    );
    const sources = (["source", "build", "normalizer", "query_runner"] as const).flatMap(
      (role, index) => {
        const bytes = sourceBytes[index];
        if (bytes === undefined) throw new Error("missing source bytes");
        const extra = Buffer.from(`${role}-additional`);
        return [
          { role, path: `/src/${role}.ts`, bytes, current_bytes: bytes },
          { role, path: `/src/${role}-extra.ts`, bytes: extra, current_bytes: extra },
        ];
      }
    );
    const impl = planScaP03ImplementationV3(fx.run_id, "implementation", "rev1", sources).identity;
    const config = { ...fx.config, implementation_identity_sha256: impl.implementation_sha256 };
    const reviewBody = {
      schema_id: SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
      schema_version: 1,
      producer: SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
      oracle_sha256: oracle.oracle_sha256,
      parser_identity_sha256: oracle.parser.identity_sha256,
      fixture_content_sha256: (["php", "javascript", "typescript"] as const).map((language) => {
        const fixture = fixtures.find((x) => x.language === language);
        if (fixture === undefined) throw new Error("missing fixture");
        return fixture.content_sha256;
      }),
      expected_cases: projectSourceOracleCases(oracle),
    };
    const reviewBytes = Buffer.from(
      canonicalJson({ ...reviewBody, review_sha256: sha256(canonicalJson(reviewBody)) })
    );
    const review_ref = fx.store.persist({
      metadata: {
        schema_version: 2,
        run_id: fx.run_id,
        phase: "SCA-P03",
        branch_id: null,
        kind: "sca-p03-source-oracle-review",
        operation_id: "independent-review",
        version: 1,
        producer: SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
        media_type: "application/json",
        content_schema: { schema_id: SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA, schema_version: 1 },
        parent_ref: null,
        upstream_refs: [oracleRef],
      },
      content: reviewBytes,
    });
    const profile: unknown = JSON.parse(
      Buffer.from(fx.store.read(fx.bindings.qualification_profile_ref)).toString()
    );
    const policy: unknown = JSON.parse(
      Buffer.from(fx.store.read(fx.bindings.runtime_policy_ref)).toString()
    );
    const manifest: ScaP03FreezeManifestV3 = {
      run_id: fx.run_id,
      corpus_id: "freeze-corpus",
      query_set_id: "freeze-set",
      release_id: "freeze-release",
      implementation_id: "implementation",
      implementation_revision: "rev1",
      root_tool_id: "joern",
      policy_id: "policy",
      profile: validateScaP03QualificationProfileV2(profile),
      policy: validateScaP03RuntimePolicyV1(policy),
      config,
      measured: {
        docker_executable_bytes: readFileSync(process.execPath),
        docker_client_version: "1.0.0",
        docker_server_version: "1.0.0",
        image_ref: config.image_ref,
        image_id: `sha256:${"b".repeat(64)}`,
        joern_version: "4.0.627",
        php_frontend_version: "4.0.627",
        javascript_frontend_version: "4.0.627",
        jvm_version: "1",
        php_runtime_version: "1",
        helper_version: "1",
      },
      oracle_bytes: oracleBytes,
      review_ref,
      review_bytes: reviewBytes,
      validated_at: stamp,
      fixtures: fixtures.map((x) => ({ language: x.language, bytes: x.bytes })),
      implementation: sources,
    };
    expect(() =>
      freezeScaP03BootstrapV3(fx.store, { ...manifest, review_bytes: Buffer.from("{}") })
    ).toThrow();
    expect(() =>
      freezeScaP03BootstrapV3(fx.store, {
        ...manifest,
        implementation: [sources[0], sources[0], sources[2], sources[3]],
      })
    ).toThrow("p03_freeze_implementation_invalid");
    expect(() =>
      freezeScaP03BootstrapV3(fx.store, {
        ...manifest,
        implementation: sources.map((x, i) =>
          i === 0 ? { ...x, current_bytes: Buffer.from("drift") } : x
        ),
      })
    ).toThrow("p03_freeze_implementation_invalid");
    expect(() => {
      Reflect.apply(freezeScaP03BootstrapV3, undefined, [
        fx.store,
        {
          ...manifest,
          implementation: sources.map((x, i) => (i === 0 ? { ...x, role: "unknown" } : x)),
        },
      ]);
    }).toThrow("p03_freeze_implementation_invalid");
    expect(() =>
      freezeScaP03BootstrapV3(fx.store, {
        ...manifest,
        implementation: sources.map((x, i) =>
          i === 0
            ? { ...x, bytes: Buffer.from("substituted"), current_bytes: Buffer.from("substituted") }
            : x
        ),
      })
    ).toThrow("p03_freeze_implementation_identity_drift");
    expect(() =>
      freezeScaP03BootstrapV3(fx.store, {
        ...manifest,
        config: { ...config, expected_docker_executable_sha256: sha256("wrong") },
      })
    ).toThrow("p03_freeze_package_measurement_invalid");
    expect(() =>
      freezeScaP03BootstrapV3(fx.store, {
        ...manifest,
        measured: { ...manifest.measured, php_frontend_version: "" },
      })
    ).toThrow("p03_freeze_package_measurement_invalid");
    expect(() =>
      freezeScaP03BootstrapV3(fx.store, {
        ...manifest,
        policy: { ...manifest.policy, max_ast_nodes: 1 },
      })
    ).toThrow();
    expect(
      fx.store.lastVersion(
        fx.run_id,
        "SCA-P03",
        null,
        "sca-p03-qualification-fixture-content",
        "freeze-fixture-0"
      )
    ).toBe(0);
    for (const staging_parent of [
      path.join(config.staging_parent, "other"),
      `${config.staging_parent}/.`,
    ]) {
      expect(() =>
        freezeScaP03BootstrapV3(fx.store, {
          ...manifest,
          config: { ...config, staging_parent },
        })
      ).toThrow("p03_freeze_package_measurement_invalid");
    }
    expect(() =>
      freezeScaP03BootstrapV3(fx.store, {
        ...manifest,
        policy: { ...manifest.policy, staging_parent_sha256: sha256("wrong path") },
      })
    ).toThrow("p03_freeze_package_measurement_invalid");
    expect(
      fx.store.lastVersion(fx.run_id, "SCA-P03", null, "sca-p03-runtime-policy", "freeze-policy")
    ).toBe(0);
    const frozen = freezeScaP03BootstrapV3(fx.store, manifest);
    expect(
      readP03BootstrapInputs(fx.store, frozen.bindings, fx.run_id).policy.staging_parent_sha256
    ).toBe(sha256(config.staging_parent));
    for (const ref of frozen.refs) {
      const body = Buffer.from(fx.store.read(ref)).toString("utf8");
      const metadata = canonicalJson(fx.store.metadata(ref));
      for (const privatePath of [
        config.staging_parent,
        config.docker_executable,
        ...sources.map((entry) => entry.path),
      ]) {
        expect(body, ref.operation_id).not.toContain(privatePath);
        expect(metadata, ref.operation_id).not.toContain(privatePath);
        expect(canonicalJson(ref), ref.operation_id).not.toContain(privatePath);
      }
    }
    expect(frozen.bindings.implementation_source_refs).toHaveLength(8);
    expect(frozen.implementation_mappings).toHaveLength(8);
    expect(new Set(frozen.implementation_mappings.map((entry) => entry.ref.artifact_id)).size).toBe(
      8
    );
    const storedIdentity: unknown = JSON.parse(
      Buffer.from(fx.store.read(frozen.bindings.implementation_identity_ref)).toString("utf8")
    );
    const roleHashes = Object.fromEntries(
      (["source", "build", "normalizer", "query_runner"] as const).map((role) => [
        `${role}_sha256`,
        sha256(
          canonicalJson(
            frozen.implementation_mappings
              .filter((file) => file.role === role)
              .map((file) => ({ ref: file.ref, current_sha256: sha256(file.bytes) }))
              .sort((a, b) => a.ref.artifact_id.localeCompare(b.ref.artifact_id))
          )
        ),
      ])
    );
    expect(storedIdentity).toMatchObject(roleHashes);
    for (const file of frozen.implementation_mappings)
      expect(Buffer.from(fx.store.read(file.ref))).toEqual(Buffer.from(file.bytes));
    expect(() =>
      planScaP03ImplementationV3(fx.run_id, "implementation", "rev1", [
        ...sources,
        { ...sources[0], path: "/src/duplicate.ts" },
      ])
    ).not.toThrow();
    expect(() =>
      planScaP03ImplementationV3(fx.run_id, "implementation", "rev1", [
        ...sources,
        { ...sources[0], role: "build", path: sources[1]?.path ?? "" },
      ])
    ).toThrow("p03_freeze_implementation_invalid");
    expect(() =>
      planScaP03ImplementationV3(fx.run_id, "implementation", "rev1", [
        ...sources,
        ...Array.from({ length: 63 }, (_, i) => ({
          ...sources[0],
          path: `/src/over-${String(i)}.ts`,
        })),
      ])
    ).toThrow("p03_freeze_implementation_invalid");
    const maxFiles = (["source", "build", "normalizer", "query_runner"] as const).flatMap((role) =>
      Array.from({ length: 32 }, (_, index) => {
        const bytes = Buffer.from(`${role}-${String(index)}`);
        return { role, path: `/src/${role}-${String(index)}.ts`, bytes, current_bytes: bytes };
      })
    );
    expect(
      planScaP03ImplementationV3(fx.run_id, "implementation", "rev1", maxFiles).mappings
    ).toHaveLength(128);
    expect(() =>
      planScaP03ImplementationV3(fx.run_id, "implementation", "rev1", [
        ...maxFiles,
        { ...sources[0], path: "/src/one-too-many.ts" },
      ])
    ).toThrow("p03_freeze_implementation_invalid");
    expect(() =>
      planScaP03ImplementationV3(fx.run_id, "implementation", "rev1", [
        ...sources.slice(1),
        { ...sources[0], path: "relative.ts" },
      ])
    ).toThrow("p03_freeze_implementation_invalid");
    expect(frozen.bindings.query_plan_refs).toHaveLength(7);
    const plans = frozen.bindings.query_plan_refs.map((ref) => {
      const value: unknown = JSON.parse(Buffer.from(fx.store.read(ref)).toString());
      return validateScaP03QueryPlanV2(value);
    });
    expect(plans.map((plan) => plan.steps[0])).toEqual([
      { kind: "select_node", node_class: "method" },
      { kind: "select_node", node_class: "method" },
      { kind: "select_node", node_class: "call" },
      { kind: "select_node", node_class: "control_structure" },
      { kind: "select_node", node_class: "identifier" },
      { kind: "select_node", node_class: "call" },
      { kind: "select_node", node_class: "method" },
    ]);
    expect(plans[4]?.steps).toContainEqual({
      kind: "traverse_edge",
      edge: "reaching_def",
      max_hops: 16,
    });
    expect(frozen.bindings.query_script_refs).toHaveLength(7);
    expect(new Set(frozen.bindings.query_script_refs.map((ref) => ref.content_digest)).size).toBe(
      7
    );
    expect(() =>
      readP03BootstrapInputs(
        fx.store,
        {
          ...frozen.bindings,
          implementation_source_refs: [...frozen.bindings.implementation_source_refs].reverse(),
        },
        fx.run_id
      )
    ).toThrow("p03_bootstrap_artifact_provenance_invalid");
    expect(() =>
      readP03BootstrapInputs(
        fx.store,
        {
          ...frozen.bindings,
          query_plan_refs: [...frozen.bindings.query_plan_refs].reverse(),
        },
        fx.run_id
      )
    ).toThrow();
    expect(freezeScaP03BootstrapV3(fx.store, manifest).refs).toEqual(frozen.refs);
    expect(() =>
      freezeScaP03BootstrapV3(fx.store, {
        ...manifest,
        review_ref: { ...review_ref, run_id: "foreign" },
      })
    ).toThrow();
    expect(() => freezeScaP03BootstrapV3(fx.store, { ...manifest, corpus_id: "changed" })).toThrow(
      "p03_freeze_adopt_conflict"
    );
    const cliRoot = mkdtempSync(path.join(os.tmpdir(), "p03-cli-blocked-"));
    roots.push(cliRoot);
    const privateDir = path.join(cliRoot, "private");
    mkdirSync(privateDir, { mode: 0o700 });
    const storeRoot = path.join(cliRoot, "store");
    const project_id = `prj_${"a".repeat(32)}`;
    const fresh = ArtifactStore.provision(storeRoot, { projectId: project_id });
    fresh.close();
    const file = (name: string, bytes: Uint8Array, mode = 0o600): string => {
      const location = path.join(privateDir, name);
      writeFileSync(location, bytes, { mode });
      return location;
    };
    const dockerFile = file("docker", Buffer.from("fake docker executable"), 0o700);
    const cliSources = sources.map((entry, index) => ({
      role: entry.role,
      path: file(`source-${String(index)}`, entry.bytes),
      bytes: entry.bytes,
      current_bytes: entry.bytes,
    }));
    const cliIdentity = planScaP03ImplementationV3(
      "cli-blocked-run",
      "implementation",
      "rev1",
      cliSources
    ).identity;
    const cliConfig = {
      ...config,
      docker_executable: dockerFile,
      expected_docker_executable_sha256: sha256(readFileSync(dockerFile)),
      implementation_identity_sha256: cliIdentity.implementation_sha256,
      staging_parent: privateDir,
    };
    // Docker's repository manifest digest and image configuration ID are distinct identities.
    const image_id = `sha256:${"c".repeat(64)}`;
    cliConfig.deployment_identity_sha256 = sha256(
      canonicalJson({
        docker_executable_sha256: cliConfig.expected_docker_executable_sha256,
        docker_client_version: cliConfig.expected_docker_client_version,
        docker_server_version: cliConfig.expected_docker_server_version,
        image_id,
        joern_version: cliConfig.expected_joern_version,
      })
    );
    const cliManifest = {
      schema_id: "penny.sca-p03-cli-freeze-manifest.v1",
      schema_version: 1,
      store_root: storeRoot,
      project_id,
      run_id: "cli-blocked-run",
      working_dir: privateDir,
      create_store: false,
      corpus_id: manifest.corpus_id,
      query_set_id: manifest.query_set_id,
      release_id: manifest.release_id,
      implementation_id: manifest.implementation_id,
      implementation_revision: manifest.implementation_revision,
      root_tool_id: manifest.root_tool_id,
      policy_id: manifest.policy_id,
      oracle_path: file("oracle.json", oracleBytes),
      source_oracle_review_path: file("review.json", reviewBytes),
      profile_path: file("profile.json", Buffer.from(canonicalJson(manifest.profile))),
      policy_path: file(
        "policy.json",
        Buffer.from(
          canonicalJson({ ...manifest.policy, staging_parent_sha256: sha256(privateDir) })
        )
      ),
      fixtures: fixtures.map((entry, i) => ({
        language: entry.language,
        path: file(`fixture-${String(i)}`, entry.bytes),
      })),
      implementation: cliSources.map((entry) => ({ role: entry.role, path: entry.path })),
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
    };
    const manifestFile = file("manifest.json", Buffer.from(canonicalJson(cliManifest)));
    let createdName = "";
    let commands = 0;
    const fakeDocker: DockerRunnerV1 = async ({ argv }) => {
      commands++;
      if (argv[0] === "version")
        return JSON.stringify({
          Client: { Version: cliConfig.expected_docker_client_version },
          Server: { Version: cliConfig.expected_docker_server_version },
        });
      if (argv[0] === "image")
        return JSON.stringify({ Id: image_id, RepoDigests: [cliConfig.image_ref] });
      if (argv[0] === "container" && argv[1] === "create") {
        createdName = argv[argv.indexOf("--name") + 1] ?? "";
        return "a".repeat(64);
      }
      if (argv[0] === "container" && argv[1] === "inspect")
        return JSON.stringify({
          Id: "a".repeat(64),
          Image: image_id,
          Name: `/${createdName}`,
          HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, Init: true },
          Config: { User: `${String(process.getuid?.())}:${String(process.getgid?.())}` },
          Mounts: [],
        });
      if (argv[0] === "container" && argv[1] === "exec") {
        const entrypoint = argv[3];
        if (entrypoint === "find") {
          const pattern = argv[argv.indexOf("-name") + 1];
          if (pattern === "io.joern.joern-cli-*.jar") return "io.joern.joern-cli-4.0.627.jar\n";
          if (pattern === "io.joern.php2cpg-*.jar")
            return "io.joern.php2cpg-4.0.627-launcher.jar\nio.joern.php2cpg-4.0.627.jar\n";
          if (pattern === "io.joern.jssrc2cpg-*.jar")
            return "io.joern.jssrc2cpg-4.0.627.jar\nio.joern.jssrc2cpg-4.0.627-launcher.jar\n";
        }
        if (entrypoint === "which") return "/opt/joern/joern-cli/joern\n";
        if (entrypoint === "joern")
          return "Usage: joern [options] [<cpg.bin>]\n\nScript execution\n";
        return entrypoint === "helper" ? "helper /nonpublic/example 1.0" : "1.0";
      }
      return "";
    };
    const offlineProbe: NonNullable<ScaP03BootstrapCliDepsV1["createProbe"]> = ({
      config: candidateConfig,
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
        if (file === undefined) throw new Error("missing mapping");
        return readStableScaP03FileV1(file, 16 * 1024 * 1024);
      },
      workspacePaths: async (id) => registry.paths(id),
      workspaceIdentityDigest: async (id) => registry.digest(id),
      currentSelection: async () => readFileSync(current_selection_path),
      measureIdentity: async () => ({
        runtime_id: candidateConfig.runtime_id,
        isolation_id: candidateConfig.isolation_id,
        implementation_sha256: candidateConfig.implementation_identity_sha256,
        runtime_package_sha256: sha256(
          canonicalJson(
            runtime_package_refs
              .map((ref) => ({
                ref,
                current_sha256: sha256(store.read(ref)),
              }))
              .sort((a, b) => a.ref.artifact_id.localeCompare(b.ref.artifact_id))
          )
        ),
        deployment_sha256: candidateConfig.deployment_identity_sha256,
        docker_executable_sha256: candidateConfig.expected_docker_executable_sha256,
        docker_client_version: candidateConfig.expected_docker_client_version,
        docker_server_version: candidateConfig.expected_docker_server_version,
        image_id,
        joern_version: candidateConfig.expected_joern_version,
      }),
    });
    const emitted: string[] = [];
    let blockedCandidates = 0;
    const driftManifestFile = file(
      "drift-manifest.json",
      Buffer.from(
        canonicalJson({
          ...cliManifest,
          config: { ...cliConfig, staging_parent: cliRoot },
        })
      )
    );
    await expect(
      runScaP03BootstrapCliV1(["freeze-record", "--manifest", driftManifestFile], {
        dockerRunner: async () => {
          throw new Error("measurement must not run");
        },
        createProbe: offlineProbe,
      })
    ).rejects.toThrow("p03_cli_staging_parent_mismatch");
    expect(commands).toBe(0);
    await runScaP03BootstrapCliV1(["freeze-record", "--manifest", manifestFile], {
      dockerRunner: fakeDocker,
      createProbe: offlineProbe,
      deterministicTestCandidate: async () => {
        blockedCandidates++;
        throw new Error("offline candidate failed");
      },
      emit: (line) => emitted.push(line),
    });
    expect(commands).toBeGreaterThan(5);
    const handoff = parseScaP03CliCanonical(
      ScaP03CliFreezeHandoffSchema,
      readFileSync(path.join(privateDir, "freeze-handoff.json"))
    );
    expect(handoff.status).toBe("blocked");
    expect(handoff.attempt_ref.kind).toBe("sca-p03-attempt-witness");
    expect(handoff.record_ref).toBeNull();
    expect(handoff.cleanup_ref).toBeNull();
    expect(handoff.isolation_ref).toBeNull();
    const diagnostic = readFileSync(path.join(privateDir, "blocked-diagnostic.json"), "utf8");
    expect(diagnostic).toContain('"reason_code":"candidate_failed"');
    expect(lstatSync(path.join(privateDir, "blocked-diagnostic.json")).mode & 0o777).toBe(0o600);
    expect(handoff.bindings.implementation_source_refs).toHaveLength(8);
    expect(emitted).toHaveLength(1);
    await runScaP03BootstrapCliV1(["freeze-record", "--manifest", manifestFile], {
      dockerRunner: fakeDocker,
      createProbe: offlineProbe,
      deterministicTestCandidate: async () => {
        blockedCandidates++;
        throw new Error("candidate replayed");
      },
      emit: () => undefined,
    });
    expect(blockedCandidates).toBe(1);
    expect(lstatSync(path.join(privateDir, "freeze-handoff.json")).mode & 0o777).toBe(0o600);
    const reopened = ArtifactStore.openExisting(storeRoot, { projectId: project_id });
    const toolchainRef = handoff.bindings.runtime_package_refs.find(
      (ref) => ref.operation_id === "freeze-package-2"
    );
    if (toolchainRef === undefined) throw new Error("toolchain ref missing");
    expect(reopened.read(toolchainRef).toString("utf8")).not.toContain("/nonpublic/example");
    expect(
      reopened.lastVersion(
        "cli-blocked-run",
        "SCA-P03",
        null,
        "sca-p03-bootstrap-record",
        "bootstrap-sca-p03-bootstrap-record"
      )
    ).toBe(0);
    reopened.close();
    const readyDir = path.join(cliRoot, "ready");
    mkdirSync(readyDir, { mode: 0o700 });
    const readyRoot = path.join(cliRoot, "ready-store");
    const readyStore = ArtifactStore.provision(readyRoot, { projectId: project_id });
    readyStore.close();
    const readyRun = "cli-ready-run";
    const readyImplementation = planScaP03ImplementationV3(
      readyRun,
      "implementation",
      "rev1",
      cliSources
    );
    const readyConfig = {
      ...cliConfig,
      implementation_identity_sha256: readyImplementation.identity.implementation_sha256,
      staging_parent: readyDir,
    };
    const readyPolicyPath = path.join(readyDir, "policy.json");
    writeFileSync(
      readyPolicyPath,
      canonicalJson({ ...manifest.policy, staging_parent_sha256: sha256(readyDir) }),
      { mode: 0o600 }
    );
    const readyManifest = {
      ...cliManifest,
      store_root: readyRoot,
      run_id: readyRun,
      working_dir: readyDir,
      policy_path: readyPolicyPath,
      config: readyConfig,
    };
    const readyManifestPath = path.join(readyDir, "freeze-manifest.json");
    writeFileSync(readyManifestPath, canonicalJson(readyManifest), { mode: 0o600 });
    const invalidProductionRun = "cli-invalid-production-run";
    const [rootExecutableRef, rootMeasurementRef, rootToolchainRef] =
      handoff.bindings.runtime_package_refs;
    if (
      rootExecutableRef === undefined ||
      rootMeasurementRef === undefined ||
      rootToolchainRef === undefined
    )
      throw new Error("runtime package fixture incomplete");
    const invalidProductionManifestPath = path.join(
      readyDir,
      "invalid-production-freeze-manifest.json"
    );
    writeFileSync(
      invalidProductionManifestPath,
      canonicalJson({
        ...readyManifest,
        schema_id: "penny.sca-p03-cli-production-freeze-manifest.v1",
        create_store: false,
        run_id: invalidProductionRun,
        accepted_p01: {
          request_ref: handoff.bindings.runtime_policy_ref,
          obligation_ledger_ref: handoff.bindings.runtime_identity_ref,
          campaign_manifest_core_ref: handoff.bindings.implementation_identity_ref,
          admission_evidence_ref: handoff.bindings.qualification_profile_ref,
          p01_gate_ref: handoff.bindings.fixture_corpus_ref,
          campaign_manifest_ref: handoff.bindings.baseline_query_set_ref,
          frozen_refs: [handoff.bindings.source_oracle_ref],
        },
        toolchain_ref: rootToolchainRef,
        root_executable_ref: rootExecutableRef,
        root_measurement_ref: rootMeasurementRef,
      }),
      { mode: 0o600 }
    );
    const commandsBeforeProductionPreflight = commands;
    await expect(
      runScaP03BootstrapCliV1(
        ["freeze-production-record", "--manifest", invalidProductionManifestPath],
        {
          dockerRunner: fakeDocker,
          createProbe: offlineProbe,
        }
      )
    ).rejects.toThrow();
    expect(commands).toBe(commandsBeforeProductionPreflight);
    const productionPreflightStore = ArtifactStore.openExisting(readyRoot, {
      projectId: project_id,
    });
    try {
      expect(
        productionPreflightStore.lastVersion(
          invalidProductionRun,
          "SCA-P03",
          null,
          "sca-p03-implementation-source",
          "freeze-implementation-source-0"
        )
      ).toBe(0);
    } finally {
      productionPreflightStore.close();
    }
    const name = "penny-p03-00000000-0000-4000-8000-000000000002";
    const id = "c".repeat(64);
    let candidates = 0;
    await runScaP03BootstrapCliV1(["freeze-record", "--manifest", readyManifestPath], {
      dockerRunner: fakeDocker,
      createProbe: offlineProbe,
      deterministicTestCandidate: async (sink) => ({
        runtime_id: readyConfig.runtime_id,
        isolation_id: readyConfig.isolation_id,
        runtime_tree_sha256: image_id.slice(7),
        isolation_profile_sha256: readyConfig.isolation_profile_sha256,
        implementation_identity_sha256: readyConfig.implementation_identity_sha256,
        deployment_identity_sha256: readyConfig.deployment_identity_sha256,
        measured_joern_version: readyConfig.expected_joern_version,
        max_num_def: readyConfig.max_num_def,
        qualify: async ({
          fixtures: candidatesFixtures,
          expected_cases,
          query_release,
          source_oracle_validation_ref,
        }) => {
          candidates++;
          const workspace = path.join(readyDir, "candidate-workspace");
          mkdirSync(workspace, { mode: 0o700 });
          const stat = lstatSync(workspace);
          sink.startWorkspace(canonicalJson({ path: workspace, dev: stat.dev, ino: stat.ino }));
          sink.create(name, ["container", "create"]);
          sink.id(name, id);
          const projection = canonicalJson({
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
            cap_drop: ["ALL"],
            security_opt: ["no-new-privileges"],
            pids: readyConfig.pids,
            memory: readyConfig.memory_bytes,
            memory_swap: readyConfig.memory_bytes,
            nano_cpus: Math.round(readyConfig.cpus * 1_000_000_000),
            log: "none",
            tmpfs: {
              "/tmp": "rw,exec,nosuid,nodev,size=67108864",
              "/work": `rw,exec,nosuid,nodev,size=${String(readyConfig.max_workspace_bytes)},mode=0700,uid=${String(process.getuid?.())},gid=${String(process.getgid?.())}`,
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
          });
          sink.inspect(name, '{"inspect":true}', projection);
          sink.startContainer(name);
          sink.command(name, ["container", "exec"], true);
          sink.response(name, "ok");
          sink.readback(name, Buffer.from("graph"));
          sink.removal(name, true);
          rmSync(workspace, { recursive: true });
          sink.finishWorkspace(true);
          return {
            executed_query_release_sha256: query_release.release_sha256,
            cases: expected_cases.map((expected) => {
              const fixture = candidatesFixtures.find((f) => f.language === expected.language);
              if (fixture === undefined) throw new Error("fixture missing");
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
      emit: (line) => emitted.push(line),
    });
    expect(candidates).toBe(1);
    await runScaP03BootstrapCliV1(["freeze-record", "--manifest", readyManifestPath], {
      dockerRunner: fakeDocker,
      createProbe: offlineProbe,
      deterministicTestCandidate: async () => {
        candidates++;
        throw new Error("candidate replayed");
      },
      emit: () => undefined,
    });
    expect(candidates).toBe(1);
    const readyHandoffFile = path.join(readyDir, "freeze-handoff.json");
    const readyHandoffBytes = readFileSync(readyHandoffFile);
    const readyHandoff = parseScaP03CliCanonical(ScaP03CliFreezeHandoffSchema, readyHandoffBytes);
    expect(readyHandoff.status).toBe("ready_for_review");
    if (
      readyHandoff.record_ref === null ||
      readyHandoff.cleanup_ref === null ||
      readyHandoff.isolation_ref === null
    )
      throw new Error("ready refs missing");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const signed = {
      external_review_id: "ready-review",
      record_ref: readyHandoff.record_ref,
      attempt_ref: readyHandoff.attempt_ref,
      cleanup_ref: readyHandoff.cleanup_ref,
      isolation_ref: readyHandoff.isolation_ref,
      reviewer_id: "reviewer",
      reviewer_authority_id: "review-authority",
      decision: "PASS",
      reviewed_at: new Date(Date.now() + 2000).toISOString(),
    };
    const externalFile = path.join(readyDir, "external-review.json");
    writeFileSync(
      externalFile,
      canonicalJson({
        ...signed,
        signature: sign(null, Buffer.from(canonicalJson(signed)), privateKey).toString("base64"),
      }),
      { mode: 0o600 }
    );
    const keyFile = path.join(readyDir, "reviewer-key.pem");
    writeFileSync(keyFile, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
    const packageRefs = readyHandoff.bindings.runtime_package_refs.map((ref) => ({
      ref,
      path: path.join(readyDir, `package-${ref.operation_id.slice(-1)}.json`),
    }));
    expect(lstatSync(path.join(readyDir, "registry.json")).mode & 0o777).toBe(0o600);
    for (const entry of packageRefs) expect(lstatSync(entry.path).mode & 0o777).toBe(0o600);
    const sealManifest = {
      schema_id: "penny.sca-p03-cli-seal-manifest.v1",
      schema_version: 1,
      store_root: readyRoot,
      project_id,
      run_id: readyRun,
      working_dir: readyDir,
      config: readyConfig,
      freeze_handoff_path: readyHandoffFile,
      freeze_handoff_sha256: sha256(readyHandoffBytes),
      implementation: readyImplementation.mappings.map((entry) => ({
        role: entry.role,
        path: entry.path,
        ref: entry.ref,
      })),
      runtime_packages: packageRefs,
      external_review_path: externalFile,
      reviewer_public_key_path: keyFile,
      reviewer_public_key_sha256: sha256(publicKey.export({ type: "spki", format: "der" })),
      reviewer_id: "reviewer",
      reviewer_authority_id: "review-authority",
      evaluator_id: "evaluator",
      attester_id: "attester",
      attestation_id: "ready-attestation",
    };
    const sealFile = path.join(readyDir, "seal-manifest.json");
    writeFileSync(sealFile, canonicalJson(sealManifest), { mode: 0o600 });
    const badSealFile = path.join(readyDir, "drift-seal.json");
    writeFileSync(
      badSealFile,
      canonicalJson({ ...sealManifest, config: { ...readyConfig, staging_parent: privateDir } }),
      { mode: 0o600 }
    );
    await expect(
      runScaP03BootstrapCliV1(["seal", "--manifest", badSealFile], {
        createProbe: () => {
          throw new Error("probe must not run");
        },
      })
    ).rejects.toThrow("p03_cli_staging_parent_mismatch");
    expect(() => lstatSync(path.join(readyDir, "selection.json"))).toThrow();
    const notSealed = ArtifactStore.openExisting(readyRoot, { projectId: project_id });
    expect(
      notSealed.lastVersion(
        readyRun,
        "SCA-P03",
        null,
        "sca-p03-external-review",
        "bootstrap-external-review"
      )
    ).toBe(0);
    notSealed.close();
    await runScaP03BootstrapCliV1(["seal", "--manifest", sealFile], {
      createProbe: offlineProbe,
      emit: (line) => emitted.push(line),
    });
    const sealedFile = path.join(readyDir, "sealed-handoff.json");
    const sealedBytes = readFileSync(sealedFile);
    const sealed = parseScaP03CliCanonical(ScaP03CliSealedHandoffSchema, sealedBytes);
    expect(sealed.status).toBe("verified");
    const verifyFile = path.join(readyDir, "verify-manifest.json");
    writeFileSync(
      verifyFile,
      canonicalJson({
        ...sealManifest,
        schema_id: "penny.sca-p03-cli-verify-manifest.v1",
        sealed_handoff_path: sealedFile,
        sealed_handoff_sha256: sha256(sealedBytes),
      }),
      { mode: 0o600 }
    );
    parseScaP03CliCanonical(ScaP03CliVerifyManifestSchema, readFileSync(verifyFile));
    await runScaP03BootstrapCliV1(["verify", "--manifest", verifyFile], {
      createProbe: offlineProbe,
      emit: (line) => emitted.push(line),
    });
    expect(emitted).toHaveLength(4);
    // Fresh CLI-issued lineage, not a hand-built proof. Import original metadata/bytes,
    // verify from the new store and use exact refs in the real P03 host-owner path.
    using issuedStore = new ArtifactStore(readyRoot, { projectId: project_id }, "verify");
    using importedStore = ArtifactStore.provision(path.join(cliRoot, "imported-store"), {
      projectId: project_id,
    });
    const imported = new Set<string>();
    const importExact = (ref: ArtifactRef): void => {
      if (imported.has(ref.artifact_id)) return;
      const metadata = issuedStore.metadata(ref);
      for (const upstream of metadata.upstream_refs) importExact(upstream);
      if (metadata.parent_ref !== null) importExact(metadata.parent_ref);
      expect(importedStore.persist({ metadata, content: issuedStore.read(ref) })).toEqual(ref);
      expect(importedStore.metadata(ref)).toEqual(metadata);
      expect(importedStore.read(ref)).toEqual(issuedStore.read(ref));
      imported.add(ref.artifact_id);
    };
    importExact(sealed.binding_ref);
    const productionInputs = SCA_P03_PRODUCTION_INPUT_CONTRACTS;
    for (const [ref, contract] of [
      [readyHandoff.bindings.runtime_policy_ref, productionInputs.runtime_policy],
      [readyHandoff.bindings.runtime_identity_ref, productionInputs.runtime_identity],
      [readyHandoff.bindings.implementation_identity_ref, productionInputs.implementation_identity],
      [readyHandoff.bindings.qualification_profile_ref, productionInputs.qualification_profile],
      [readyHandoff.bindings.fixture_corpus_ref, productionInputs.fixture_corpus],
      [readyHandoff.bindings.baseline_query_set_ref, productionInputs.baseline_query_set],
      [sealed.host_attestation_ref, productionInputs.host_attestation],
      ...readyHandoff.bindings.fixture_content_refs.map(
        (ref) => [ref, productionInputs.fixture_content] as const
      ),
      ...readyHandoff.bindings.query_script_refs.map(
        (ref) => [ref, productionInputs.query_script] as const
      ),
      ...readyHandoff.bindings.query_plan_refs.map(
        (ref) => [ref, productionInputs.query_plan] as const
      ),
    ] as const) {
      expect(ref).toMatchObject(contract);
      expect(importedStore.refById(ref.artifact_id)).toEqual(ref);
    }
    for (const [ref, producer] of [
      [sealed.record_ref, P03_BOOTSTRAP_ROLES.evaluator],
      [sealed.attempt_ref, P03_BOOTSTRAP_ROLES.evaluator],
      [sealed.review_ref, P03_BOOTSTRAP_ROLES.reviewer],
      [sealed.binding_ref, P03_BOOTSTRAP_ROLES.attester],
      [sealed.cleanup_ref, P03_BOOTSTRAP_ROLES.cleanup],
      [sealed.isolation_ref, P03_BOOTSTRAP_ROLES.isolation],
    ] as const)
      expect(ref.producer).toBe(producer);
    const importedRecord = validateScaP03BootstrapQualificationRecordV3(
      JSON.parse(importedStore.read(sealed.record_ref).toString())
    );
    const importedProbe = offlineProbe({
      config: readyConfig,
      store: importedStore,
      registry: ScaP03WorkspaceRegistryV1.resume(path.join(readyDir, "registry.json")),
      runtime_package_refs: readyHandoff.bindings.runtime_package_refs,
      build_files: Object.fromEntries(
        [...sealManifest.implementation, ...sealManifest.runtime_packages].map((entry) => [
          entry.ref.artifact_id,
          entry.path,
        ])
      ),
      current_selection_path: path.join(readyDir, "selection.json"),
    });
    const importedAuthority = createScaP03BootstrapHostAuthorityV1({
      store: importedStore,
      probe: importedProbe,
      record_ref: sealed.record_ref,
      binding_ref: sealed.binding_ref,
      attempt_ref: sealed.attempt_ref,
      cleanup_ref: sealed.cleanup_ref,
      isolation_ref: sealed.isolation_ref,
      receipt_ref: sealed.receipt_ref,
      reviewer_public_key: publicKey,
      reviewer_id: sealManifest.reviewer_id,
      reviewer_authority_id: sealManifest.reviewer_authority_id,
      evaluator_id: sealManifest.evaluator_id,
      attester_id: sealManifest.attester_id,
      implementation_refs: readyHandoff.bindings.implementation_source_refs,
      runtime_package_refs: readyHandoff.bindings.runtime_package_refs,
    });
    const importedProof = {
      authority: importedAuthority,
      config: readyConfig,
      binding_ref: sealed.binding_ref,
      qualification_record_ref: sealed.record_ref,
      review_ref: sealed.review_ref,
      host_attestation_ref: sealed.host_attestation_ref,
    };
    expect((await verifyScaP03BootstrapProofV3(importedProof)).proof_sha256).toBe(
      sealed.proof_sha256
    );
    const importedRuntimeValue: unknown = JSON.parse(
      importedStore.read(readyHandoff.bindings.runtime_identity_ref).toString("utf8")
    );
    const importedRuntimeIdentity = validateScaP03JoernRuntimeIdentityV1(importedRuntimeValue);
    const invalidProductionBindings = createScaP03FrozenProductionBindingsV1({
      run_id: readyRun,
      frozen: readyHandoff.bindings,
      roots: {
        accepted_p01: {
          request_ref: readyHandoff.bindings.runtime_policy_ref,
          obligation_ledger_ref: readyHandoff.bindings.runtime_identity_ref,
          campaign_manifest_core_ref: readyHandoff.bindings.implementation_identity_ref,
          admission_evidence_ref: readyHandoff.bindings.qualification_profile_ref,
          p01_gate_ref: readyHandoff.bindings.fixture_corpus_ref,
          campaign_manifest_ref: readyHandoff.bindings.baseline_query_set_ref,
          frozen_refs: [readyHandoff.bindings.source_oracle_ref],
        },
        root_tool_id: importedRuntimeIdentity.root_tool_id,
        toolchain_ref: importedRuntimeIdentity.toolchain_ref,
        root_executable_ref: importedRuntimeIdentity.root_executable_ref,
        root_measurement_ref: importedRuntimeIdentity.root_measurement_ref,
      },
    });
    let productionRunnerCalls = 0;
    const productionCacheRoot = path.join(readyDir, "production-result-cache");
    mkdirSync(productionCacheRoot, { mode: 0o700 });
    await expect(
      createScaP03ProductionHostCompositionV1({
        config: readyConfig,
        result_cache_root: productionCacheRoot,
        proof: {
          ...importedProof,
          store: importedStore,
          production_bindings: invalidProductionBindings,
          production_record_ref: sealed.record_ref,
        },
        runner: async () => {
          productionRunnerCalls += 1;
          throw new Error("production runner must not execute");
        },
      })
    ).rejects.toThrow();
    expect(productionRunnerCalls).toBe(0);
    for (const ref of [sealed.host_attestation_ref, sealed.binding_ref]) {
      const wrongProducer = importedStore.persist({
        metadata: {
          ...importedStore.metadata(ref),
          operation_id: `wrong-issuer-${ref.kind}`,
          producer: "host:untrusted",
        },
        content: importedStore.read(ref),
      });
      await expect(
        verifyScaP03BootstrapProofV3({
          ...importedProof,
          ...(ref === sealed.host_attestation_ref
            ? { host_attestation_ref: wrongProducer }
            : { binding_ref: wrongProducer }),
        })
      ).rejects.toThrow("p03_host_config_or_proof_mismatch");
    }
    const importedRuntime = await createScaP03DockerBootstrapDeterministicTestOnlyRuntimeV3(
      readyConfig,
      importedProof,
      hostOwnerDockerRunner(image_id.slice(7))
    );
    expect(isVerifiedScaP03DockerHostRuntimeV1(importedRuntime)).toBe(false);
    await p03HostOwnerRegression({
      store: importedStore,
      runtime: importedRuntime,
      record: importedRecord,
      attestation_ref: sealed.host_attestation_ref,
      defect: "none",
      qualification_fixture: async (value) => ({
        executed_query_release_sha256: value.query_release.release_sha256,
        cases: value.expected_cases.map((expected) => {
          const fixture = value.fixtures.find((entry) => entry.language === expected.language);
          if (fixture === undefined) throw new Error("fixture missing");
          return observedFromSourceCase(
            expected,
            fixture,
            value.query_release.release_sha256,
            value.source_oracle_validation_ref
          );
        }),
      }),
    });
    const driftVerifyFile = path.join(readyDir, "drift-verify.json");
    writeFileSync(
      driftVerifyFile,
      canonicalJson({
        ...sealManifest,
        schema_id: "penny.sca-p03-cli-verify-manifest.v1",
        sealed_handoff_path: sealedFile,
        sealed_handoff_sha256: sha256(sealedBytes),
        config: { ...readyConfig, staging_parent: privateDir },
      }),
      { mode: 0o600 }
    );
    await expect(
      runScaP03BootstrapCliV1(["verify", "--manifest", driftVerifyFile], {
        createProbe: () => {
          throw new Error("probe must not run");
        },
      })
    ).rejects.toThrow("p03_cli_staging_parent_mismatch");
    // Enumerate every public artifact, including attempt/record and simulated sealed lineage.
    // Private manifests, workspace registry, and handoffs are deliberately not artifact bodies.
    const artifactIds: unknown = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "-e",
          'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});process.stdout.write(JSON.stringify(db.prepare("SELECT artifact_id FROM artifacts").all().map(r=>r.artifact_id)));db.close()',
          path.join(readyRoot, "manifest.db"),
        ],
        { encoding: "utf8" }
      )
    );
    if (!Array.isArray(artifactIds) || artifactIds.length === 0)
      throw new Error("no public artifacts");
    const publicStore = ArtifactStore.openExisting(readyRoot, { projectId: project_id });
    try {
      for (const artifactId of artifactIds) {
        if (typeof artifactId !== "string") throw new Error("invalid artifact id");
        const ref = publicStore.refById(artifactId);
        if (ref === undefined) throw new Error("missing public artifact");
        for (const privatePath of [
          cliRoot,
          readyRoot,
          storeRoot,
          privateDir,
          readyDir,
          dockerFile,
          manifestFile,
          readyManifestPath,
          sealFile,
          verifyFile,
          ...cliSources.map((entry) => entry.path),
        ]) {
          expect(publicStore.read(ref).toString("utf8"), ref.operation_id).not.toContain(
            privatePath
          );
          expect(canonicalJson(publicStore.metadata(ref)), ref.operation_id).not.toContain(
            privatePath
          );
          expect(canonicalJson(ref), ref.operation_id).not.toContain(privatePath);
        }
      }
    } finally {
      publicStore.close();
    }
    const active = execFileSync(
      process.execPath,
      [
        "-e",
        "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});const row=db.prepare(\"SELECT COUNT(*) AS n FROM artifacts WHERE kind IN ('sca-p03-gate','sca-p04-gate') OR phase = 'SCA-P04'\").get();process.stdout.write(String(row.n));db.close()",
        path.join(readyRoot, "manifest.db"),
      ],
      { encoding: "utf8" }
    );
    expect(active).toBe("0");
    await runScaP03BootstrapCliV1(["seal", "--manifest", sealFile], {
      createProbe: offlineProbe,
      emit: (line) => emitted.push(line),
    });
    expect(readFileSync(sealedFile)).toEqual(sealedBytes);
    const selectionFile = path.join(readyDir, "selection.json");
    const originalSelection = readFileSync(selectionFile);
    const selected: unknown = JSON.parse(originalSelection.toString("utf8"));
    if (selected === null || typeof selected !== "object" || !("selection_sha256" in selected))
      throw new Error("selection invalid");
    const { selection_sha256: _digest, ...selectionDraft } = selected;
    void _digest;
    await expect(
      runScaP03BootstrapCliV1(["seal", "--manifest", sealFile], {
        createProbe: (input) => ({
          ...offlineProbe(input),
          containerCensus: async () => [{ name, id }],
        }),
      })
    ).rejects.toThrow("p03_host_container_present");
    expect(readFileSync(selectionFile, "utf8")).toContain('"status":"revoked"');
    writeFileSync(selectionFile, originalSelection);
    writeFileSync(
      selectionFile,
      canonicalJson({
        ...selectionDraft,
        status: "revoked",
        selection_sha256: sha256(canonicalJson({ ...selectionDraft, status: "revoked" })),
      })
    );
    await expect(
      runScaP03BootstrapCliV1(["verify", "--manifest", verifyFile], {
        createProbe: offlineProbe,
        emit: (line) => emitted.push(line),
      })
    ).rejects.toThrow();
    writeFileSync(selectionFile, originalSelection);
    writeFileSync(cliSources[0].path, "changed source");
    await expect(
      runScaP03BootstrapCliV1(["verify", "--manifest", verifyFile], {
        createProbe: offlineProbe,
        emit: (line) => emitted.push(line),
      })
    ).rejects.toThrow("p03_host_build_drift");
    writeFileSync(cliSources[0].path, cliSources[0].bytes);
    await expect(
      runScaP03BootstrapCliV1(["verify", "--manifest", verifyFile], {
        createProbe: (input) => ({
          ...offlineProbe(input),
          containerCensus: async () => [{ name, id }],
        }),
        emit: (line) => emitted.push(line),
      })
    ).rejects.toThrow("p03_host_container_present");
    await expect(
      runScaP03BootstrapCliV1(["verify", "--manifest", verifyFile], {
        createProbe: (input) => ({
          ...offlineProbe(input),
          now: () => new Date("2030-01-01T00:00:00.000Z"),
        }),
        emit: (line) => emitted.push(line),
      })
    ).rejects.toThrow("p03_host_evidence_stale");
    await expect(
      runScaP03BootstrapCliV1(["verify", "--manifest", verifyFile], {
        createProbe: (input) => {
          const observed = offlineProbe(input);
          return {
            ...observed,
            measureIdentity: async () => ({
              ...(await observed.measureIdentity()),
              image_id: `sha256:${"f".repeat(64)}`,
            }),
          };
        },
      })
    ).rejects.toThrow("p03_host_deployment_drift");
    const unsigned = { ...signed, reviewer_id: "different-reviewer" };
    writeFileSync(
      externalFile,
      canonicalJson({
        ...unsigned,
        signature: sign(null, Buffer.from(canonicalJson(signed)), privateKey).toString("base64"),
      })
    );
    await expect(
      runScaP03BootstrapCliV1(["seal", "--manifest", sealFile], {
        createProbe: offlineProbe,
      })
    ).rejects.toThrow("p03_cli_review_untrusted");
    expect(() =>
      parseScaP03CliCanonical(
        ScaP03CliFreezeManifestSchema,
        Buffer.from(canonicalJson({ ...readyManifest, unexpected: true }))
      )
    ).toThrow();
    expect(() =>
      parseScaP03CliCanonical(
        ScaP03CliFreezeManifestSchema,
        Buffer.from('{"schema_id":"x","schema_id":"y"}')
      )
    ).toThrow("p03_cli_input_noncanonical");
    expect(() =>
      parseScaP03CliCanonical(
        ScaP03CliFreezeManifestSchema,
        Buffer.from(` ${canonicalJson(readyManifest)}`)
      )
    ).toThrow("p03_cli_input_noncanonical");
    expect(() =>
      parseScaP03CliCanonical(
        ScaP03CliFreezeManifestSchema,
        Buffer.from(
          canonicalJson({
            ...readyManifest,
            implementation: [
              ...readyManifest.implementation.slice(1),
              readyManifest.implementation[1],
            ],
          })
        )
      )
    ).toThrow("p03_cli_paths_invalid");
    const badFingerprint = path.join(readyDir, "bad-key-manifest.json");
    writeFileSync(
      badFingerprint,
      canonicalJson({ ...sealManifest, reviewer_public_key_sha256: sha256("wrong-key") }),
      { mode: 0o600 }
    );
    await expect(
      runScaP03BootstrapCliV1(["seal", "--manifest", badFingerprint], {
        createProbe: offlineProbe,
      })
    ).rejects.toThrow("p03_cli_reviewer_key_untrusted");
    writeFileSync(externalFile, canonicalJson({ ...signed, signature: "A".repeat(86) + "==" }));
    await expect(
      runScaP03BootstrapCliV1(["seal", "--manifest", sealFile], {
        createProbe: offlineProbe,
      })
    ).rejects.toThrow("p03_cli_review_untrusted");
    const future = { ...signed, reviewed_at: new Date(Date.now() + 3_600_000).toISOString() };
    writeFileSync(
      externalFile,
      canonicalJson({
        ...future,
        signature: sign(null, Buffer.from(canonicalJson(future)), privateKey).toString("base64"),
      })
    );
    await expect(
      runScaP03BootstrapCliV1(["seal", "--manifest", sealFile], {
        createProbe: offlineProbe,
      })
    ).rejects.toThrow("p03_cli_review_time_invalid");
    writeFileSync(
      externalFile,
      canonicalJson({
        ...signed,
        signature: sign(null, Buffer.from(canonicalJson(signed)), privateKey).toString("base64"),
      })
    );
    const badRole = path.join(readyDir, "bad-role.json");
    writeFileSync(
      badRole,
      canonicalJson({ ...sealManifest, evaluator_id: sealManifest.reviewer_id }),
      { mode: 0o600 }
    );
    await expect(
      runScaP03BootstrapCliV1(["seal", "--manifest", badRole], {
        createProbe: offlineProbe,
      })
    ).rejects.toThrow("p03_cli_review_untrusted");
    const badRef = path.join(readyDir, "bad-ref.json");
    writeFileSync(
      badRef,
      canonicalJson({
        ...sealManifest,
        implementation: [sealManifest.implementation[1], ...sealManifest.implementation.slice(1)],
      }),
      { mode: 0o600 }
    );
    await expect(
      runScaP03BootstrapCliV1(["seal", "--manifest", badRef], {
        createProbe: offlineProbe,
      })
    ).rejects.toThrow("p03_cli_paths_invalid");
    const link = path.join(readyDir, "verify-link.json");
    symlinkSync(verifyFile, link);
    await expect(
      runScaP03BootstrapCliV1(["verify", "--manifest", link], {
        createProbe: offlineProbe,
      })
    ).rejects.toThrow();
    chmodSync(verifyFile, 0o644);
    await expect(
      runScaP03BootstrapCliV1(["verify", "--manifest", verifyFile], {
        createProbe: offlineProbe,
      })
    ).rejects.toThrow("p03_host_file_custody_invalid");
    chmodSync(verifyFile, 0o600);
    writeFileSync(
      externalFile,
      canonicalJson({
        ...signed,
        signature: sign(null, Buffer.from(canonicalJson(signed)), privateKey).toString("base64"),
      })
    );
    const packageFile = packageRefs[0]?.path;
    if (packageFile === undefined) throw new Error("package missing");
    const originalPackage = readFileSync(packageFile);
    writeFileSync(packageFile, "package drift");
    await expect(
      runScaP03BootstrapCliV1(["verify", "--manifest", verifyFile], {
        createProbe: offlineProbe,
      })
    ).rejects.toThrow("p03_host_build_drift");
    writeFileSync(packageFile, originalPackage);
    const workspace = path.join(readyDir, "candidate-workspace");
    mkdirSync(workspace, { mode: 0o700 });
    writeFileSync(path.join(workspace, "unexpected"), "residue", { mode: 0o600 });
    await expect(
      runScaP03BootstrapCliV1(["verify", "--manifest", verifyFile], {
        createProbe: offlineProbe,
      })
    ).rejects.toThrow("p03_workspace_not_empty");
    rmSync(workspace, { recursive: true });
    const mismatchedProject = path.join(readyDir, "wrong-project.json");
    writeFileSync(
      mismatchedProject,
      canonicalJson({
        ...sealManifest,
        schema_id: "penny.sca-p03-cli-verify-manifest.v1",
        project_id: `prj_${"b".repeat(32)}`,
        sealed_handoff_path: sealedFile,
        sealed_handoff_sha256: sha256(sealedBytes),
      }),
      { mode: 0o600 }
    );
    await expect(
      runScaP03BootstrapCliV1(["verify", "--manifest", mismatchedProject], {
        createProbe: offlineProbe,
      })
    ).rejects.toThrow("p03_cli_handoff_mismatch");
    fx.store.close();
  }, 60_000);
});
