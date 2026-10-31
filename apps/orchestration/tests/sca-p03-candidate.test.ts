import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef } from "../dist/contracts.js";
import {
  resolvePlaybook,
  runtimeRegistrationSha256,
  validateRegistrationContract,
} from "../dist/playbooks/registry.js";
import {
  scaP03InputArtifacts,
  validateScaP03AcceptedP02CohortV1,
} from "../dist/sca/p03-admission.js";
import { SCA_P01_MAX_SCOPE_ITEMS } from "../dist/sca/p01-contracts.js";
import {
  SCA_P02_CANDIDATE_PRODUCER,
  SCA_P02_CANDIDATE_REQUEST_KIND,
  SCA_P02_HOST_ATTESTATION_KIND,
  SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
  SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
  SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
  SCA_P02_REQUEST_V1_SCHEMA,
  SCA_P02_RUNTIME_POLICY_PRODUCER,
  SCA_P02_RUNTIME_POLICY_V1_SCHEMA,
  validateScaP02P03TransitionV1,
  withScaP02Digest,
} from "../dist/sca/p02-contracts.js";
import {
  SCA_P03_BASELINE_QUERY_BATCH_REQUEST_V2_SCHEMA,
  SCA_P03_BASELINE_QUERY_BATCH_RESULT_V2_SCHEMA,
  SCA_P03_GRAPH_BUILD_REQUEST_V1_SCHEMA,
  SCA_P03_GRAPH_BUILD_RESULT_V1_SCHEMA,
  SCA_P03_GRAPH_COMPONENT_V1_SCHEMA,
  SCA_P03_FIDELITY_COMPLEMENT_V2_SCHEMA,
  SCA_P03_GRAPH_SUPPORT_MATRIX_V2_SCHEMA,
  SCA_P03_GATE_V1_SCHEMA,
  SCA_P03_MAX_FILES,
  SCA_P03_MAX_GRAPH_OPERATION_BYTES,
  SCA_P03_P04_TRANSITION_V2_SCHEMA,
  SCA_P03_QUERY_IDS,
  SCA_P03_QUERY_PLAN_V2_SCHEMA,
  SCA_P03_QUERY_SCRIPT_V2_SCHEMA,
  deriveScaP03GraphSupportEntriesV1,
  validateScaP03FidelityComplementEvidenceV2,
  validateScaP03GraphSupportMatrixV2,
  validateScaP03OperationRequestV1,
  validateScaP03OperationResultV1,
  validateScaP03QueryBindingAgainstPlanV2,
  validateScaP03QueryPlanV2,
  validateScaP03QueryScriptV2,
  validateScaP03TransitionAgainstGateV1,
  validateScaP03RequestV2,
  validateScaP03RuntimePolicyV1,
  scaP03P01BindingSha256,
  scaP03P02BindingSha256,
  scaP03RuntimeBindingSha256,
  withScaP03Digest,
} from "../dist/sca/p03-contracts.js";
import {
  SCA_P03_CANDIDATE_PLAYBOOK_NAME,
  SCA_P03_CANDIDATE_REGISTRATION,
  SCA_P03_OPERATION_DECLARATIONS,
} from "../dist/sca/p03-playbook.js";

function ref(label: string, digest = sha256(label)): ArtifactRef {
  const safeLabel = label.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "-");
  return {
    schema_version: 2,
    artifact_id: `art_${sha256(`artifact:${label}:${digest}`)}`,
    run_id: "p03-contract-run",
    phase: "fixture",
    branch_id: null,
    kind: `p03-${safeLabel}`,
    operation_id: `p03-${safeLabel}`,
    version: 1,
    producer: "host:p03-contract-fixture",
    media_type: "application/json",
    content_schema: { schema_id: `penny.p03-${safeLabel}.v1`, schema_version: 1 },
    byte_length: 2,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function cohortRef(input: {
  readonly label: string;
  readonly runId: string;
  readonly kind: string;
  readonly schemaId: string;
  readonly producer: string;
}): ArtifactRef {
  const digest = sha256(canonicalJson(input));
  return {
    schema_version: 2,
    artifact_id: `art_${sha256(`artifact:${input.label}:${digest}`)}`,
    run_id: input.runId,
    phase: "sca-p02-candidate",
    branch_id: null,
    kind: input.kind,
    operation_id: input.label,
    version: 1,
    producer: input.producer,
    media_type: "application/json",
    content_schema: { schema_id: input.schemaId, schema_version: 1 },
    byte_length: 2,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function fidelityRequirements(partition: "php" | "javascript_typescript") {
  const language = partition === "php" ? "php" : "javascript";
  return [
    {
      requirement_id: `${partition}-language`,
      dimension: "language" as const,
      subject: language,
      partition,
      materiality: "material" as const,
      complement_evidence_ref: null,
    },
    {
      requirement_id: `${partition}-framework`,
      dimension: "framework" as const,
      subject: "fixture-framework",
      partition,
      materiality: "material" as const,
      complement_evidence_ref: null,
    },
    {
      requirement_id: `${partition}-edge`,
      dimension: "edge_class" as const,
      subject: "call",
      partition,
      materiality: "material" as const,
      complement_evidence_ref: null,
    },
    {
      requirement_id: `${partition}-surface`,
      dimension: "surface" as const,
      subject: "entrypoint",
      partition,
      materiality: "material" as const,
      complement_evidence_ref: null,
    },
  ];
}

function queryRequest() {
  const source = ref("source", "1".repeat(64));
  const graph = ref("graph", "2".repeat(64));
  const scripts = SCA_P03_QUERY_IDS.map((queryId) => ref(`script-${queryId}`));
  const plans = SCA_P03_QUERY_IDS.map((queryId) => ref(`plan-${queryId}`));
  return validateScaP03OperationRequestV1(
    "run_baseline_query_batch",
    withScaP03Digest(
      {
        schema_id: SCA_P03_BASELINE_QUERY_BATCH_REQUEST_V2_SCHEMA,
        schema_version: 2,
        tenant_id: "tenant-p03-contract",
        project_id: "project-p03-contract",
        run_id: "p03-contract-run",
        phase_id: "SCA-P03" as const,
        operation_id: "sca-p03-baseline-query-batch-php",
        operation_kind: "run_baseline_query_batch" as const,
        p01_binding_sha256: "3".repeat(64),
        p02_binding_sha256: "4".repeat(64),
        p03_runtime_binding_sha256: "5".repeat(64),
        source_snapshot_ref: source,
        source_snapshot_sha256: source.content_digest,
        p03_request_ref: ref("request"),
        runtime_policy_ref: ref("runtime-policy"),
        joern_runtime_identity_ref: ref("runtime-identity"),
        isolation_evidence_ref: ref("isolation"),
        host_isolation_attestation_ref: null,
        implementation_identity_ref: ref("implementation"),
        qualification_profile_ref: ref("qualification-profile"),
        baseline_query_set_ref: ref("query-set"),
        runtime_id: "p03-runtime",
        runtime_kind: "simulated_joern_test_runtime" as const,
        qualification_scope: "deterministic_test_only" as const,
        runtime_tree_sha256: "6".repeat(64),
        isolation_id: "p03-isolation",
        isolation_profile_sha256: "7".repeat(64),
        partition: "php" as const,
        graph_component_ref: graph,
        graph_component_sha256: graph.content_digest,
        graph_build_request_ref: ref("graph-request"),
        graph_build_result_ref: ref("graph-result"),
        ordered_query_ids: SCA_P03_QUERY_IDS,
        fidelity_requirements: fidelityRequirements("php"),
        query_script_refs: scripts,
        query_plan_refs: plans,
        max_query_output_bytes: 1_048_576,
        max_query_items: 10_000,
        max_page_items: 100,
        max_pages_per_query: 10,
      },
      "request_sha256"
    )
  );
}

describe("inactive deterministic SCA P03 candidate", () => {
  it("closes the public staging binding over a digest only and refuses legacy paths", () => {
    const policy = {
      schema_id: "penny.sca-p03-runtime-policy.v1",
      schema_version: 1,
      policy_id: "policy",
      staging_parent_sha256: sha256("/caller-private/staging"),
      source_posture: "read_only",
      network_access: "denied",
      package_acquisition: "forbidden",
      target_execution: "forbidden",
      shell_execution: "forbidden",
      joern_server: "forbidden",
      process_timeout_ms: 1000,
      max_graph_bytes: 1000,
      max_query_output_bytes: 1000,
      max_query_items: 1,
      max_page_items: 1,
      max_pages_per_query: 1,
      max_ast_depth: 1,
      max_ast_nodes: 1,
      max_num_def: 1,
    };
    expect(validateScaP03RuntimePolicyV1(policy)).toEqual(policy);
    expect(canonicalJson(policy)).not.toContain("/caller-private/staging");
    const { staging_parent_sha256: _binding, ...legacy } = policy;
    expect(() => validateScaP03RuntimePolicyV1(legacy)).toThrow();
    expect(() =>
      validateScaP03RuntimePolicyV1({ ...legacy, staging_parent: "/caller-private/staging" })
    ).toThrow();
    expect(() =>
      validateScaP03RuntimePolicyV1({ ...policy, staging_parent: "/caller-private/staging" })
    ).toThrow();
    for (const staging_parent_sha256 of [
      "",
      "/caller-private/staging",
      "0".repeat(63),
      "g".repeat(64),
      "A".repeat(64),
    ]) {
      expect(() => validateScaP03RuntimePolicyV1({ ...policy, staging_parent_sha256 })).toThrow();
    }
    expect(_binding).toBe(sha256("/caller-private/staging"));
    expect(sha256("/caller-private/staging/.")).not.toBe(_binding);
    expect(sha256(canonicalJson("/caller-private/staging"))).not.toBe(_binding);
  });
  it("requires both exact P02 qualification refs in the request digest and input set", () => {
    const accepted_p01 = {
      request_ref: ref("p01-request"),
      obligation_ledger_ref: ref("p01-ledger"),
      campaign_manifest_core_ref: ref("p01-core"),
      admission_evidence_ref: ref("p01-admission"),
      p01_gate_ref: ref("p01-gate"),
      campaign_manifest_ref: ref("p01-manifest"),
      frozen_refs: [ref("p01-frozen")],
    };
    const p02Ref = (name: string, kind: string, schema: string, version = 1) => {
      const result = cohortRef({
        label: name,
        runId: "p02-bound-run",
        kind,
        schemaId: schema,
        producer: "host:sca-p02-qualification-authority",
      });
      return {
        ...result,
        phase: "SCA-P02",
        content_schema: { schema_id: schema, schema_version: version },
      };
    };
    const accepted_p02 = {
      transition_ref: ref("transition"),
      p02_request_ref: ref("p02-request"),
      gate_ref: ref("operational-gate"),
      qualification_definition_ref: p02Ref(
        "definition",
        "sca-p02-v3-definition-snapshot",
        "penny.sca-p02-v3-definition-snapshot.v1"
      ),
      qualification_gate_ref: p02Ref(
        "gate",
        "sca-p02-phase-gate-v3",
        "penny.sca-phase-gate-record.v3",
        3
      ),
      m1_ref: ref("m1"),
      coverage_matrix_ref: ref("coverage"),
      evidence_manifest_ref: ref("manifest"),
      successor_ledger_ref: ref("ledger"),
      evidence_refs: Array.from({ length: 26 }, (_, i) => ref(`evidence-${i}`)),
    };
    const base = {
      schema_id: "penny.sca-p03-request.v2",
      schema_version: 2,
      tenant_id: "p03-tenant",
      project_id: "p03-project",
      run_id: "p03-contract-run",
      phase_id: "SCA-P03",
      accepted_p01,
      accepted_p02,
      source_snapshot_ref: ref("source"),
      source_snapshot_sha256: ref("source").content_digest,
      runtime_policy_ref: ref("runtime"),
      joern_runtime_identity_ref: ref("joern"),
      isolation_evidence_ref: ref("isolation"),
      host_isolation_attestation_ref: null,
      implementation_identity_ref: ref("implementation"),
      qualification_profile_ref: ref("profile"),
      fixture_corpus_ref: ref("corpus"),
      source_oracle_ref: ref("source-oracle"),
      source_oracle_validation_ref: ref("source-oracle-receipt"),
      fixture_content_refs: [ref("fixture-a"), ref("fixture-b"), ref("fixture-c")],
      fidelity_complement_refs: [],
      baseline_query_set_ref: ref("query-set"),
      query_script_refs: Array.from({ length: 7 }, (_, i) => ref(`script-${i}`)),
      query_plan_refs: Array.from({ length: 7 }, (_, i) => ref(`plan-${i}`)),
      runtime_package_refs: [ref("runtime-package")],
      requested_at: "2026-09-25T00:00:00Z",
    };
    const seal = (p02: typeof accepted_p02) => {
      const candidate = { ...base, accepted_p02: p02 };
      return withScaP03Digest(
        {
          ...candidate,
          p01_binding_sha256: scaP03P01BindingSha256(candidate),
          p02_binding_sha256: scaP03P02BindingSha256(candidate),
          p03_runtime_binding_sha256: scaP03RuntimeBindingSha256(candidate),
        },
        "request_sha256"
      );
    };
    const request = validateScaP03RequestV2(seal(accepted_p02));
    for (const field of ["source_oracle_ref", "source_oracle_validation_ref"] as const) {
      const { [field]: _omitted, ...withoutOracleBinding } = request;
      expect(() =>
        validateScaP03RequestV2(
          withScaP03Digest(
            {
              ...withoutOracleBinding,
              p03_runtime_binding_sha256: request.p03_runtime_binding_sha256,
            },
            "request_sha256"
          )
        )
      ).toThrow();
    }
    expect(() =>
      validateScaP03RequestV2({
        ...request,
        schema_id: "penny.sca-p03-request.v1",
        schema_version: 1,
      })
    ).toThrow();
    const refs = scaP03InputArtifacts(request).artifacts.map((item) => item.ref);
    expect(refs).toContainEqual(accepted_p02.qualification_definition_ref);
    expect(refs).toContainEqual(accepted_p02.qualification_gate_ref);
    for (const missing of ["qualification_definition_ref", "qualification_gate_ref"] as const) {
      const p02 = Object.fromEntries(
        Object.entries(accepted_p02).filter(([key]) => key !== missing)
      );
      expect(() => validateScaP03RequestV2({ ...request, accepted_p02: p02 })).toThrow();
    }
    expect(() =>
      validateScaP03RequestV2({
        ...request,
        accepted_p02: { ...accepted_p02, qualification_gate_ref: accepted_p02.gate_ref },
      })
    ).toThrow();
    expect(() =>
      validateScaP03RequestV2({
        ...request,
        accepted_p02: {
          ...accepted_p02,
          qualification_gate_ref: {
            ...accepted_p02.qualification_gate_ref,
            producer: "host:impostor",
          },
        },
      })
    ).toThrow();
  });

  it("remains inactive, declares no worker/model phases, and stays off the package root", () => {
    expect(resolvePlaybook(SCA_P03_CANDIDATE_PLAYBOOK_NAME)).toBeUndefined();
    expect(() => validateRegistrationContract(SCA_P03_CANDIDATE_REGISTRATION)).not.toThrow();
    expect(runtimeRegistrationSha256(SCA_P03_CANDIDATE_REGISTRATION)).toBe(
      runtimeRegistrationSha256(SCA_P03_CANDIDATE_REGISTRATION)
    );
    expect(SCA_P03_CANDIDATE_REGISTRATION.worker).toMatchObject({
      kind: "none",
      model_policy: "none",
    });
    expect(SCA_P03_CANDIDATE_REGISTRATION.worker.phases.size).toBe(0);
    const packageRoot = readFileSync(path.resolve(import.meta.dirname, "../src/index.ts"), "utf8");
    expect(packageRoot).not.toContain("p03-playbook");
    expect(packageRoot).not.toContain("p03-contracts");
  });

  it("rejects a valid P02 transition cross-spliced onto another valid P02/P01 cohort", () => {
    const buildCohort = (label: string) => {
      const runId = `p02-${label}`;
      const authorityRef = (kind: string, schemaId: string, producer: string) =>
        cohortRef({ label: `${label}-${kind}`, runId, kind, schemaId, producer });
      const p02RequestRef = authorityRef(
        SCA_P02_CANDIDATE_REQUEST_KIND,
        SCA_P02_REQUEST_V1_SCHEMA,
        SCA_P02_CANDIDATE_PRODUCER
      );
      const runtimePolicyRef = authorityRef(
        "sca-p02-runtime-policy",
        SCA_P02_RUNTIME_POLICY_V1_SCHEMA,
        SCA_P02_RUNTIME_POLICY_PRODUCER
      );
      const isolationEvidenceRef = authorityRef(
        "sca-p02-isolation-evidence",
        SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
        SCA_P02_ISOLATION_EVIDENCE_PRODUCER
      );
      const isolationHostAttestationRef = authorityRef(
        SCA_P02_HOST_ATTESTATION_KIND,
        SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
        SCA_P02_ISOLATION_EVIDENCE_PRODUCER
      );
      const acceptedP01 = {
        request_ref: ref(`${label}-p01-request`),
        obligation_ledger_ref: ref(`${label}-p01-ledger`),
        campaign_manifest_core_ref: ref(`${label}-p01-core`),
        admission_evidence_ref: ref(`${label}-p01-admission`),
        p01_gate_ref: ref(`${label}-p01-gate`),
        campaign_manifest_ref: ref(`${label}-p01-manifest`),
        frozen_refs: [ref(`${label}-p01-frozen`)],
      };
      const acceptedP02 = {
        transition_ref: ref(`${label}-transition-ref`),
        p02_request_ref: p02RequestRef,
        gate_ref: ref(`${label}-p02-gate`),
        qualification_definition_ref: cohortRef({
          label: `${label}-qualification-definition`,
          runId,
          kind: "sca-p02-v3-definition-snapshot",
          schemaId: "penny.sca-p02-v3-definition-snapshot.v1",
          producer: "host:sca-p02-qualification-authority",
        }),
        qualification_gate_ref: cohortRef({
          label: `${label}-qualification-gate`,
          runId,
          kind: "sca-p02-phase-gate-v3",
          schemaId: "penny.sca-phase-gate-record.v3",
          producer: "host:sca-p02-qualification-authority",
        }),
        m1_ref: ref(`${label}-p02-m1`),
        coverage_matrix_ref: ref(`${label}-p02-coverage`),
        evidence_manifest_ref: ref(`${label}-p02-manifest`),
        successor_ledger_ref: ref(`${label}-p02-ledger`),
        evidence_refs: [
          runtimePolicyRef,
          isolationEvidenceRef,
          isolationHostAttestationRef,
          ...Array.from({ length: 24 }, (_, index) => ref(`${label}-evidence-${index}`)),
        ],
      };
      const transition = validateScaP02P03TransitionV1(
        withScaP02Digest(
          {
            schema_id: "penny.sca-p02-p03-transition.v1",
            schema_version: 1,
            run_id: runId,
            from_phase_id: "SCA-P02" as const,
            to_phase_id: "SCA-P03" as const,
            p02_request_ref: p02RequestRef,
            runtime_policy_ref: runtimePolicyRef,
            isolation_evidence_ref: isolationEvidenceRef,
            isolation_host_attestation_ref: isolationHostAttestationRef,
            p01_request_ref: acceptedP01.request_ref,
            p01_campaign_manifest_core_ref: acceptedP01.campaign_manifest_core_ref,
            p01_campaign_manifest_ref: acceptedP01.campaign_manifest_ref,
            successor_ledger_ref: acceptedP02.successor_ledger_ref,
            evidence_manifest_ref: acceptedP02.evidence_manifest_ref,
            p02_gate_ref: acceptedP02.gate_ref,
            coverage_matrix_ref: acceptedP02.coverage_matrix_ref,
            m1_ref: acceptedP02.m1_ref,
            consumed_as_of: "2026-09-20T00:00:00.000Z",
            qualification_claimed: false as const,
            campaign_terminal: false as const,
            release_eligible: false as const,
          },
          "transition_sha256"
        )
      );
      return {
        request: { accepted_p01: acceptedP01, accepted_p02: acceptedP02 },
        transition,
        p02_request: {
          run_id: runId,
          runtime_policy_ref: runtimePolicyRef,
          isolation_evidence_ref: isolationEvidenceRef,
          isolation_host_attestation_ref: isolationHostAttestationRef,
          accepted_p01: acceptedP01,
        },
        evidence_manifest: {
          p02_request_ref: p02RequestRef,
          runtime_policy_ref: runtimePolicyRef,
          isolation_evidence_ref: isolationEvidenceRef,
          isolation_host_attestation_ref: isolationHostAttestationRef,
          p01_request_ref: acceptedP01.request_ref,
          p01_campaign_manifest_core_ref: acceptedP01.campaign_manifest_core_ref,
          p01_campaign_manifest_ref: acceptedP01.campaign_manifest_ref,
          p01_predecessor_ledger_ref: acceptedP01.obligation_ledger_ref,
          successor_ledger_ref: acceptedP02.successor_ledger_ref,
          coverage_matrix_ref: acceptedP02.coverage_matrix_ref,
        },
      };
    };
    const cohortA = buildCohort("a");
    const cohortB = buildCohort("b");
    expect(() => validateScaP03AcceptedP02CohortV1(cohortA)).not.toThrow();
    expect(() => validateScaP03AcceptedP02CohortV1(cohortB)).not.toThrow();
    expect(() =>
      validateScaP03AcceptedP02CohortV1({
        ...cohortB,
        transition: cohortA.transition,
      })
    ).toThrow(/cross-spliced/u);
  });

  it("accepts only the frozen typed query AST and rejects caller-authored native code", () => {
    const plan = withScaP03Digest(
      {
        schema_id: SCA_P03_QUERY_PLAN_V2_SCHEMA,
        schema_version: 2,
        plan_id: "p03-plan-contract",
        query_id: SCA_P03_QUERY_IDS[0],
        steps: [
          { kind: "select_node" as const, node_class: "method" as const },
          { kind: "project" as const, fields: ["node_id", "name"] as const },
          { kind: "limit" as const, max_items: 100 },
        ],
        max_ast_depth: 8,
        max_ast_nodes: 16,
      },
      "plan_sha256"
    );
    expect(validateScaP03QueryPlanV2(plan)).toEqual(plan);
    expect(() =>
      validateScaP03QueryPlanV2(
        withScaP03Digest(
          {
            schema_id: SCA_P03_QUERY_PLAN_V2_SCHEMA,
            schema_version: 2,
            plan_id: "p03-missing-dispatch",
            query_id: "p03.framework-dispatch.v2",
            steps: plan.steps,
            max_ast_depth: plan.max_ast_depth,
            max_ast_nodes: plan.max_ast_nodes,
          },
          "plan_sha256"
        )
      )
    ).toThrow(/required relationship traversal/u);
    expect(() => validateScaP03QueryPlanV2({ ...plan, native_query: "cpg.method.l" })).toThrow(
      /additional properties/u
    );
    expect(() =>
      validateScaP03QueryPlanV2(
        withScaP03Digest(
          {
            schema_id: SCA_P03_QUERY_PLAN_V2_SCHEMA,
            schema_version: 2,
            plan_id: "p03-plan-contract",
            query_id: SCA_P03_QUERY_IDS[0],
            steps: [{ kind: "traverse_edge", edge: "arbitrary_scala", max_hops: 1 }],
            max_ast_depth: 8,
            max_ast_nodes: 16,
          },
          "plan_sha256"
        )
      )
    ).toThrow();
    const commentBytes = Buffer.from("// ignored Scala query\n", "utf8");
    expect(() =>
      validateScaP03QueryScriptV2({
        schema_id: SCA_P03_QUERY_SCRIPT_V2_SCHEMA,
        schema_version: 2,
        query_id: SCA_P03_QUERY_IDS[0],
        script_id: "p03-comment-only-script",
        language: "penny_typed_query_binding_v2",
        review_status: "host_reviewed_frozen",
        encoding: "base64",
        content_base64: commentBytes.toString("base64"),
        byte_length: commentBytes.byteLength,
        content_sha256: sha256(commentBytes),
      })
    ).toThrow(/not a typed binding/u);
    expect(() =>
      validateScaP03QueryScriptV2({
        schema_id: SCA_P03_QUERY_SCRIPT_V2_SCHEMA,
        schema_version: 2,
        query_id: SCA_P03_QUERY_IDS[0],
        script_id: "p03-arbitrary-scala-script",
        language: "scala",
        review_status: "host_reviewed_frozen",
        encoding: "base64",
        content_base64: commentBytes.toString("base64"),
        byte_length: commentBytes.byteLength,
        content_sha256: sha256(commentBytes),
      })
    ).toThrow();
    const substitutedBindingBytes = Buffer.from(
      canonicalJson({
        schema_id: "penny.sca-p03-query-binding.v2",
        schema_version: 2,
        release_id: "p03-release-contract",
        query_id: SCA_P03_QUERY_IDS[0],
        executor_id: SCA_P03_QUERY_IDS[0],
        plan_id: "substituted-plan",
        plan_sha256: "f".repeat(64),
      }),
      "utf8"
    );
    const substitutedScript = validateScaP03QueryScriptV2({
      schema_id: SCA_P03_QUERY_SCRIPT_V2_SCHEMA,
      schema_version: 2,
      query_id: SCA_P03_QUERY_IDS[0],
      script_id: "p03-substituted-plan-script",
      language: "penny_typed_query_binding_v2",
      review_status: "host_reviewed_frozen",
      encoding: "base64",
      content_base64: substitutedBindingBytes.toString("base64"),
      byte_length: substitutedBindingBytes.byteLength,
      content_sha256: sha256(substitutedBindingBytes),
    });
    expect(() =>
      validateScaP03QueryBindingAgainstPlanV2({
        release_id: "p03-release-contract",
        query_id: SCA_P03_QUERY_IDS[0],
        script: substitutedScript,
        plan: validateScaP03QueryPlanV2(plan),
      })
    ).toThrow(/substituted or plan-drifted/u);
  });

  it("rejects partial or missing-query batches even when their self-digest is recomputed", () => {
    const request = queryRequest();
    if (request.operation_kind !== "run_baseline_query_batch") {
      throw new Error("query fixture kind drifted");
    }
    const descriptors = SCA_P03_QUERY_IDS.map((queryId) => ({
      query_id: queryId,
      page_number: 1,
      item_count: queryId === "p03.unsupported-surface.v2" ? 0 : 1,
      byte_length: 100,
      content_sha256: sha256(queryId),
    }));
    const footers = SCA_P03_QUERY_IDS.map((queryId) => ({
      query_id: queryId,
      item_count: queryId === "p03.unsupported-surface.v2" ? 0 : 1,
      byte_count: 100,
      page_count: 1,
      complete: true,
    }));
    const common = {
      schema_id: SCA_P03_BASELINE_QUERY_BATCH_RESULT_V2_SCHEMA,
      schema_version: 2,
      tenant_id: request.tenant_id,
      project_id: request.project_id,
      run_id: request.run_id,
      phase_id: request.phase_id,
      operation_id: request.operation_id,
      operation_kind: request.operation_kind,
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
      status: "complete" as const,
      blocker_codes: [],
      completed_at: "2026-09-20T00:00:00.000Z",
      partition: request.partition,
      graph_component_ref: request.graph_component_ref,
      graph_component_sha256: request.graph_component_sha256,
      graph_build_result_ref: request.graph_build_result_ref,
      baseline_query_set_ref: request.baseline_query_set_ref,
      executed_query_release_sha256: sha256("executed-query-release"),
      page_descriptors: descriptors,
      query_footers: footers,
      fidelity_observations: request.fidelity_requirements.map((entry) => ({
        requirement_id: entry.requirement_id,
        support: "supported" as const,
        reason_code: null,
      })),
      complete: true,
      truncated: false,
    };
    const valid = withScaP03Digest(common, "result_sha256");
    expect(validateScaP03OperationResultV1(request.operation_kind, request, valid)).toEqual(valid);
    const unsupportedBody = {
      ...common,
      page_descriptors: descriptors.map((entry) => ({ ...entry, item_count: 1 })),
      query_footers: footers.map((entry) => ({ ...entry, item_count: 1 })),
    };
    const qualifiedClassification = withScaP03Digest(unsupportedBody, "result_sha256");
    expect(
      validateScaP03OperationResultV1(request.operation_kind, request, qualifiedClassification)
    ).toEqual(qualifiedClassification);
    const classified = withScaP03Digest(
      {
        ...unsupportedBody,
        fidelity_observations: common.fidelity_observations.map((entry) =>
          entry.requirement_id === "php-surface"
            ? { ...entry, support: "partial", reason_code: "unsupported_surface_observed" }
            : entry
        ),
      },
      "result_sha256"
    );
    expect(validateScaP03OperationResultV1(request.operation_kind, request, classified)).toEqual(
      classified
    );
    const missing = withScaP03Digest(
      {
        ...common,
        page_descriptors: descriptors.slice(0, -1),
        query_footers: footers.slice(0, -1),
      },
      "result_sha256"
    );
    expect(() => validateScaP03OperationResultV1(request.operation_kind, request, missing)).toThrow(
      /missing|footers/u
    );
    const truncated = withScaP03Digest(
      {
        ...common,
        status: "truncated" as const,
        blocker_codes: ["query_truncated"],
        truncated: true,
      },
      "result_sha256"
    );
    expect(() =>
      validateScaP03OperationResultV1(request.operation_kind, request, truncated)
    ).toThrow(/completeness|inconsistent/u);
    const duplicate = withScaP03Digest(
      {
        ...common,
        page_descriptors: [descriptors[0], descriptors[0], ...descriptors.slice(1)],
        query_footers: [
          { ...footers[0], item_count: 2, byte_count: 200, page_count: 2 },
          ...footers.slice(1),
        ],
      },
      "result_sha256"
    );
    expect(() =>
      validateScaP03OperationResultV1(request.operation_kind, request, duplicate)
    ).toThrow(/contiguous, unique, or bounded/u);
    const overItems = withScaP03Digest(
      {
        ...common,
        page_descriptors: descriptors.map((entry, index) =>
          index === 0 ? { ...entry, item_count: request.max_page_items + 1 } : entry
        ),
        query_footers: footers.map((entry, index) =>
          index === 0 ? { ...entry, item_count: request.max_page_items + 1 } : entry
        ),
      },
      "result_sha256"
    );
    expect(() =>
      validateScaP03OperationResultV1(request.operation_kind, request, overItems)
    ).toThrow(/contiguous, unique, or bounded|aggregate exceeds/u);
  });

  it("rejects incomplete and cross-snapshot graph file accounting", () => {
    const source = ref("graph-source", "a".repeat(64));
    const fileDigest = sha256("<?php echo 'bound';\n");
    const request = validateScaP03OperationRequestV1(
      "build_source_graph",
      withScaP03Digest(
        {
          schema_id: SCA_P03_GRAPH_BUILD_REQUEST_V1_SCHEMA,
          schema_version: 1,
          tenant_id: "tenant-p03-contract",
          project_id: "project-p03-contract",
          run_id: "p03-contract-run",
          phase_id: "SCA-P03" as const,
          operation_id: "sca-p03-build-source-graph-php",
          operation_kind: "build_source_graph" as const,
          p01_binding_sha256: "1".repeat(64),
          p02_binding_sha256: "2".repeat(64),
          p03_runtime_binding_sha256: "3".repeat(64),
          source_snapshot_ref: source,
          source_snapshot_sha256: source.content_digest,
          p03_request_ref: ref("graph-request"),
          runtime_policy_ref: ref("graph-runtime-policy"),
          joern_runtime_identity_ref: ref("graph-runtime-identity"),
          isolation_evidence_ref: ref("graph-isolation"),
          host_isolation_attestation_ref: null,
          implementation_identity_ref: ref("graph-implementation"),
          qualification_profile_ref: ref("graph-qualification-profile"),
          baseline_query_set_ref: ref("graph-query-set"),
          runtime_id: "p03-runtime",
          runtime_kind: "simulated_joern_test_runtime" as const,
          qualification_scope: "deterministic_test_only" as const,
          runtime_tree_sha256: "4".repeat(64),
          isolation_id: "p03-isolation",
          isolation_profile_sha256: "5".repeat(64),
          partition: "php" as const,
          frontend_language: "PHP" as const,
          source_file_manifest_ref: ref("source-manifest"),
          source_custody_ref: ref("source-custody"),
          expected_files: [
            { path: "src/index.php", content_sha256: fileDigest, role: "primary" as const },
          ],
          max_num_def: 10_000,
          max_graph_bytes: 1_048_576,
        },
        "request_sha256"
      )
    );
    if (request.operation_kind !== "build_source_graph") throw new Error("graph kind drifted");
    const graphBuildKey = "6".repeat(64);
    const graphDigest = "7".repeat(64);
    const graphId = `p03graph_${sha256(
      canonicalJson({ graph_build_key_sha256: graphBuildKey, content_sha256: graphDigest })
    )}`;
    const cleanupBody = {
      workspace_removed: true,
      graph_handles_closed: true,
      process_exit_observed: true,
    };
    const resultBase = {
      schema_id: SCA_P03_GRAPH_BUILD_RESULT_V1_SCHEMA,
      schema_version: 1,
      tenant_id: request.tenant_id,
      project_id: request.project_id,
      run_id: request.run_id,
      phase_id: request.phase_id,
      operation_id: request.operation_id,
      operation_kind: request.operation_kind,
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
      status: "complete" as const,
      blocker_codes: [],
      completed_at: "2026-09-20T00:00:00.000Z",
      partition: request.partition,
      frontend_language: request.frontend_language,
      graph: {
        media_type: "application/vnd.penny.joern-cpg" as const,
        content_schema_id: SCA_P03_GRAPH_COMPONENT_V1_SCHEMA,
        byte_length: 100,
        content_sha256: graphDigest,
      },
      graph_build_key_sha256: graphBuildKey,
      graph_id: graphId,
      accounted_files: [
        {
          path: "src/index.php",
          content_sha256: fileDigest,
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
    };
    const valid = withScaP03Digest(resultBase, "result_sha256");
    expect(validateScaP03OperationResultV1("build_source_graph", request, valid)).toEqual(valid);
    expect(() =>
      validateScaP03OperationResultV1(
        "build_source_graph",
        request,
        withScaP03Digest(
          {
            ...resultBase,
            accounted_files: [{ ...resultBase.accounted_files[0], content_sha256: "8".repeat(64) }],
          },
          "result_sha256"
        )
      )
    ).toThrow(/cross-snapshot/u);
    expect(() =>
      validateScaP03OperationResultV1(
        "build_source_graph",
        request,
        withScaP03Digest({ ...resultBase, accounted_files: [] }, "result_sha256")
      )
    ).toThrow(/fewer|accounted|accounting/u);
    const failedCleanupBody = {
      workspace_removed: false,
      graph_handles_closed: true,
      process_exit_observed: true,
    };
    expect(() =>
      validateScaP03OperationResultV1(
        "build_source_graph",
        request,
        withScaP03Digest(
          {
            ...resultBase,
            cleanup_evidence: {
              ...failedCleanupBody,
              cleanup_sha256: sha256(canonicalJson(failedCleanupBody)),
            },
          },
          "result_sha256"
        )
      )
    ).toThrow(/cleanup status lacks exact cleanup evidence/u);
    expect(() =>
      validateScaP03OperationResultV1(
        "build_source_graph",
        request,
        withScaP03Digest(
          {
            ...resultBase,
            graph: { ...resultBase.graph, byte_length: request.max_graph_bytes + 1 },
          },
          "result_sha256"
        )
      )
    ).toThrow(/graph output exceeds|maximum/u);
  });

  it("authorizes P04 only from the exact positive live-qualified gate", () => {
    const source = ref("transition-source", "b".repeat(64));
    const requestRef = ref("transition-request");
    const gateRef = ref("transition-gate");
    const m1Ref = ref("transition-m1");
    const p02ManifestRef = ref("transition-p02-manifest");
    const refs = {
      entry_admission_ref: ref("transition-entry"),
      qualification_record_ref: ref("transition-qualification"),
      graph_manifest_ref: ref("transition-graph-manifest"),
      graph_support_matrix_ref: ref("transition-support"),
      baseline_query_aggregate_ref: ref("transition-aggregate"),
      candidate_packet_ref: ref("transition-packet"),
      coverage_matrix_ref: ref("transition-coverage"),
      evidence_manifest_ref: ref("transition-evidence"),
      successor_ledger_ref: ref("transition-ledger"),
      zero_model_evidence_ref: ref("transition-zero-model"),
    };
    const common = {
      tenant_id: "tenant-p03-transition",
      project_id: "project-p03-transition",
      run_id: "run-p03-transition",
      phase_id: "SCA-P03" as const,
      p01_binding_sha256: "1".repeat(64),
      p02_binding_sha256: "2".repeat(64),
      p03_runtime_binding_sha256: "3".repeat(64),
      source_snapshot_ref: source,
      source_snapshot_sha256: source.content_digest,
    };
    const gate = withScaP03Digest(
      {
        schema_id: SCA_P03_GATE_V1_SCHEMA,
        schema_version: 1,
        ...common,
        p03_request_ref: requestRef,
        ...refs,
        isolation_scope: "live_qualified" as const,
        status: "passed" as const,
        blocker_codes: [],
        evaluated_at: "2026-09-20T00:00:00.000Z",
      },
      "gate_sha256"
    );
    const transition = withScaP03Digest(
      {
        schema_id: SCA_P03_P04_TRANSITION_V2_SCHEMA,
        schema_version: 2,
        ...common,
        from_phase_id: "SCA-P03" as const,
        to_phase_id: "SCA-P04" as const,
        p03_request_ref: requestRef,
        source_oracle_ref: ref("source-oracle"),
        source_oracle_validation_ref: ref("source-oracle-receipt"),
        p02_m1_ref: m1Ref,
        p02_evidence_manifest_ref: p02ManifestRef,
        entry_admission_ref: refs.entry_admission_ref,
        qualification_record_ref: refs.qualification_record_ref,
        graph_manifest_ref: refs.graph_manifest_ref,
        graph_support_matrix_ref: refs.graph_support_matrix_ref,
        baseline_query_aggregate_ref: refs.baseline_query_aggregate_ref,
        candidate_packet_ref: refs.candidate_packet_ref,
        coverage_matrix_ref: refs.coverage_matrix_ref,
        evidence_manifest_ref: refs.evidence_manifest_ref,
        successor_ledger_ref: refs.successor_ledger_ref,
        zero_model_evidence_ref: refs.zero_model_evidence_ref,
        gate_ref: gateRef,
        p04_entry_authorized: true as const,
        campaign_terminal: false as const,
        release_eligible: false as const,
        transitioned_at: "2026-09-20T00:00:01.000Z",
      },
      "transition_sha256"
    );
    expect(
      validateScaP03TransitionAgainstGateV1({
        transition,
        gate,
        gate_ref: gateRef,
        request_ref: requestRef,
        p02_m1_ref: m1Ref,
        p02_evidence_manifest_ref: p02ManifestRef,
      })
    ).toEqual(transition);
    for (const field of ["source_oracle_ref", "source_oracle_validation_ref"] as const) {
      const { [field]: _omitted, transition_sha256: _digest, ...missing } = transition;
      expect(() =>
        validateScaP03TransitionAgainstGateV1({
          transition: withScaP03Digest(missing, "transition_sha256"),
          gate,
          gate_ref: gateRef,
          request_ref: requestRef,
          p02_m1_ref: m1Ref,
          p02_evidence_manifest_ref: p02ManifestRef,
        })
      ).toThrow();
    }
    for (const field of [
      "gate_ref",
      "p03_request_ref",
      "p02_m1_ref",
      "p02_evidence_manifest_ref",
      "source_snapshot_ref",
      "entry_admission_ref",
      "qualification_record_ref",
      "graph_manifest_ref",
      "graph_support_matrix_ref",
      "baseline_query_aggregate_ref",
      "candidate_packet_ref",
      "coverage_matrix_ref",
      "evidence_manifest_ref",
      "successor_ledger_ref",
      "zero_model_evidence_ref",
    ] as const) {
      const substituted = withScaP03Digest(
        {
          ...Object.fromEntries(
            Object.entries(transition).filter(([key]) => key !== "transition_sha256")
          ),
          [field]: ref(`substituted-${field}`),
        },
        "transition_sha256"
      );
      expect(() =>
        validateScaP03TransitionAgainstGateV1({
          transition: substituted,
          gate,
          gate_ref: gateRef,
          request_ref: requestRef,
          p02_m1_ref: m1Ref,
          p02_evidence_manifest_ref: p02ManifestRef,
        })
      ).toThrow(/exact positive P03 gate/u);
    }
    const blocked = withScaP03Digest(
      {
        ...Object.fromEntries(Object.entries(gate).filter(([key]) => key !== "gate_sha256")),
        isolation_scope: "deterministic_test_only" as const,
        status: "blocked" as const,
        blocker_codes: ["isolation_unqualified"],
      },
      "gate_sha256"
    );
    expect(() =>
      validateScaP03TransitionAgainstGateV1({
        transition,
        gate: blocked,
        gate_ref: gateRef,
        request_ref: requestRef,
        p02_m1_ref: m1Ref,
        p02_evidence_manifest_ref: p02ManifestRef,
      })
    ).toThrow(/positive P03 gate/u);
  });

  it("derives profile-bound fidelity truth and blocks unsupported material surfaces without a complement", () => {
    const requirements = [
      ...fidelityRequirements("php"),
      ...fidelityRequirements("javascript_typescript"),
    ];
    const evidence = {
      php: [ref("php-fidelity-result")],
      javascript_typescript: [ref("javascript-typescript-fidelity-result")],
    };
    const observations = requirements.map((entry) => ({
      requirement_id: entry.requirement_id,
      support:
        entry.requirement_id === "php-surface" ? ("unsupported" as const) : ("supported" as const),
      reason_code: entry.requirement_id === "php-surface" ? "unsupported_route_surface" : null,
    }));
    const derivation = {
      requirements,
      observations,
      qualification_scope: "live_qualified" as const,
      graph_component_refs: {
        php: ref("php-fidelity-graph"),
        javascript_typescript: ref("javascript-typescript-fidelity-graph"),
      },
      evidence_refs: evidence,
      qualified_complement_requirement_ids: new Set<string>(),
    };
    const entries = deriveScaP03GraphSupportEntriesV1(derivation);
    expect(() =>
      deriveScaP03GraphSupportEntriesV1({
        ...derivation,
        evidence_refs: { ...evidence, php: [] },
      })
    ).toThrow(/lacks runtime evidence/u);
    const supportedObservations = requirements.map((entry) => ({
      requirement_id: entry.requirement_id,
      support: "supported" as const,
      reason_code: null,
    }));
    const liveEntries = deriveScaP03GraphSupportEntriesV1({
      ...derivation,
      observations: supportedObservations,
    });
    expect(liveEntries.every((entry) => entry.support === "supported" && !entry.material_gap)).toBe(
      true
    );
    expect(
      liveEntries.every(
        (entry) => entry.blocker_codes.length === 0 && entry.complement_evidence_ref === null
      )
    ).toBe(true);
    const deterministicEntries = deriveScaP03GraphSupportEntriesV1({
      ...derivation,
      observations: supportedObservations,
      qualification_scope: "deterministic_test_only",
    });
    expect(
      deterministicEntries.every(
        (entry) =>
          entry.support === "partial" &&
          entry.material_gap &&
          entry.blocker_codes.includes("isolation_unqualified")
      )
    ).toBe(true);
    const source = ref("fidelity-source");
    const matrix = withScaP03Digest(
      {
        schema_id: SCA_P03_GRAPH_SUPPORT_MATRIX_V2_SCHEMA,
        schema_version: 2,
        tenant_id: "tenant-p03-fidelity",
        project_id: "project-p03-fidelity",
        run_id: "run-p03-fidelity",
        phase_id: "SCA-P03" as const,
        p01_binding_sha256: "1".repeat(64),
        p02_binding_sha256: "2".repeat(64),
        p03_runtime_binding_sha256: "3".repeat(64),
        source_snapshot_ref: source,
        source_snapshot_sha256: source.content_digest,
        profile_ref: ref("fidelity-profile"),
        entries,
        complete: false,
      },
      "matrix_sha256"
    );
    expect(validateScaP03GraphSupportMatrixV2(matrix).complete).toBe(false);
    const { matrix_sha256: _digest, ...matrixBody } = matrix;
    const liveMatrix = withScaP03Digest(
      { ...matrixBody, entries: liveEntries, complete: true },
      "matrix_sha256"
    );
    expect(validateScaP03GraphSupportMatrixV2(liveMatrix).complete).toBe(true);
    expect(
      validateScaP03GraphSupportMatrixV2(
        withScaP03Digest({ ...matrixBody, entries: deterministicEntries }, "matrix_sha256")
      ).complete
    ).toBe(false);
    for (const entries of [
      liveEntries.map((entry) => ({
        ...entry,
        qualification_scope: "deterministic_test_only" as const,
      })),
      liveEntries.map((entry) => ({ ...entry, graph_component_ref: null })),
      liveEntries.map((entry) => ({ ...entry, evidence_refs: [] })),
    ]) {
      expect(() =>
        validateScaP03GraphSupportMatrixV2(
          withScaP03Digest({ ...matrixBody, entries, complete: true }, "matrix_sha256")
        )
      ).toThrow();
    }
    expect(entries.find((entry) => entry.requirement_id === "php-surface")).toMatchObject({
      support: "unsupported",
      material_gap: true,
      blocker_codes: ["unsupported_route_surface"],
    });
    const unlocatedEntries = deriveScaP03GraphSupportEntriesV1({
      ...derivation,
      observations: requirements.map((entry) => ({
        requirement_id: entry.requirement_id,
        support: "partial" as const,
        reason_code: "path_location_unaccounted",
      })),
    });
    expect(unlocatedEntries).toHaveLength(requirements.length);
    expect(
      unlocatedEntries.every(
        (entry) =>
          entry.support === "partial" &&
          entry.material_gap &&
          entry.blocker_codes.includes("path_location_unaccounted")
      )
    ).toBe(true);
    expect(
      validateScaP03GraphSupportMatrixV2(
        withScaP03Digest(
          {
            ...Object.fromEntries(
              Object.entries(matrix).filter(([key]) => key !== "matrix_sha256")
            ),
            entries: unlocatedEntries,
            complete: false,
          },
          "matrix_sha256"
        )
      ).complete
    ).toBe(false);

    const complement = ref("php-surface-complement");
    const complementedRequirements = requirements.map((entry) =>
      entry.requirement_id === "php-surface"
        ? { ...entry, complement_evidence_ref: complement }
        : entry
    );
    expect(() =>
      deriveScaP03GraphSupportEntriesV1({
        requirements: complementedRequirements,
        observations,
        qualification_scope: "live_qualified",
        graph_component_refs: {
          php: ref("php-fidelity-graph"),
          javascript_typescript: ref("javascript-typescript-fidelity-graph"),
        },
        evidence_refs: evidence,
        qualified_complement_requirement_ids: new Set(["php-surface"]),
      })
    ).toThrow(/unverified complement/u);

    const nonMaterialRequirements = requirements.map((entry) =>
      entry.requirement_id === "php-surface"
        ? { ...entry, materiality: "non_material" as const }
        : entry
    );
    const nonMaterialEntries = deriveScaP03GraphSupportEntriesV1({
      requirements: nonMaterialRequirements,
      observations,
      qualification_scope: "live_qualified",
      graph_component_refs: {
        php: ref("php-fidelity-graph"),
        javascript_typescript: ref("javascript-typescript-fidelity-graph"),
      },
      evidence_refs: evidence,
      qualified_complement_requirement_ids: new Set(),
    });
    expect(
      nonMaterialEntries.find((entry) => entry.requirement_id === "php-surface")
    ).toMatchObject({ support: "unsupported", material_gap: false });
    expect(
      validateScaP03GraphSupportMatrixV2(
        withScaP03Digest(
          {
            ...Object.fromEntries(
              Object.entries(matrix).filter(([key]) => key !== "matrix_sha256")
            ),
            entries: nonMaterialEntries,
            complete: true,
          },
          "matrix_sha256"
        )
      ).complete
    ).toBe(true);
  });

  it("rejects self-declared fidelity complements even with live labels and review refs", () => {
    const complement = withScaP03Digest(
      {
        schema_id: SCA_P03_FIDELITY_COMPLEMENT_V2_SCHEMA,
        schema_version: 2,
        complement_id: "self-declared-complement",
        profile_id: "fidelity-profile",
        requirement_id: "php-surface",
        partition: "php",
        qualification_scope: "live_qualified",
        support: "supported",
        method_id: "declared-method",
        method_version: "1",
        producer_id: "declared-producer",
        source_snapshot_ref: ref("source"),
        graph_component_ref: ref("graph"),
        baseline_query_set_ref: ref("query-set"),
        fixture_oracle_ref: ref("oracle"),
        observed_link_refs: [ref("observed-link")],
        independent_review_ref: ref("declared-review"),
        max_hops: 1,
        max_results: 1,
        max_bytes: 1024,
      },
      "complement_sha256"
    );
    expect(() => validateScaP03FidelityComplementEvidenceV2(complement)).toThrow(
      /no approved independent review boundary/u
    );
  });

  it("keeps request, cache, and platform output capacities self-consistent", () => {
    expect(SCA_P03_OPERATION_DECLARATIONS.run_baseline_query_batch).toMatchObject({
      max_output_artifacts: 71,
      max_output_bytes: 96 * 1024 * 1024,
    });
    expect(SCA_P03_MAX_FILES).toBe(SCA_P01_MAX_SCOPE_ITEMS);
    expect(SCA_P03_OPERATION_DECLARATIONS.build_source_graph).toMatchObject({
      max_output_artifacts: 2,
      max_output_bytes: SCA_P03_MAX_GRAPH_OPERATION_BYTES,
    });
    const request = queryRequest();
    expect(() =>
      validateScaP03OperationRequestV1(
        "run_baseline_query_batch",
        withScaP03Digest(
          {
            ...Object.fromEntries(
              Object.entries(request).filter(([key]) => key !== "request_sha256")
            ),
            max_pages_per_query: 11,
          },
          "request_sha256"
        )
      )
    ).toThrow();
  });

  it("uses canonical JSON rather than object insertion order for every recomputed digest", () => {
    const request = queryRequest();
    const reparsed: unknown = JSON.parse(canonicalJson(request));
    expect(validateScaP03OperationRequestV1("run_baseline_query_batch", reparsed)).toEqual(request);
  });
});
