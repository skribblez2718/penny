import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { assertScaP02HostAttestationBindingV1 } from "../dist/sca/p02-admission.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { validateDirective, type ArtifactRef } from "../dist/contracts.js";
import type { ModelClient } from "../dist/model-client.js";
import {
  resolvePlaybook,
  runtimeRegistrationSha256,
  validateRegistrationContract,
} from "../dist/playbooks/registry.js";
import {
  SCA_M1_RECORD_V2_SCHEMA,
  SCA_P02_ANALYZER_IDS,
  buildScaP02ProvenanceV1,
  buildScaP02RawEvidenceV1,
  SCA_P02_COVERAGE_MATRIX_V1_SCHEMA,
  SCA_P02_GATE_V1_SCHEMA,
  SCA_P02_GITLEAKS_RESULT_V1_SCHEMA,
  SCA_P02_INVENTORY_RESULT_V1_SCHEMA,
  SCA_P02_OSV_COMPOSER_RESULT_V1_SCHEMA,
  SCA_P02_OSV_NPM_REQUEST_V1_SCHEMA,
  SCA_P02_OSV_NPM_RESULT_V1_SCHEMA,
  SCA_P02_OPERATION_IDS,
  SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
  SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
  SCA_P02_HOST_ATTESTATION_KIND,
  SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
  scaP02AggregateProfileSha256,
  scaP02OperationProfileSha256,
  validateScaP02HostIsolationAttestationV1,
  validateScaP02IsolationEvidenceV1,
  SCA_P02_PERSISTED_EVIDENCE_V1_SCHEMA,
  SCA_P02_SEMGREP_JS_TS_RESULT_V1_SCHEMA,
  SCA_P02_SEMGREP_PHP_REQUEST_V1_SCHEMA,
  SCA_P02_SEMGREP_PHP_RESULT_V1_SCHEMA,
  validateScaM1RecordV2,
  validateScaP02CoverageMatrixV1,
  validateScaP02GateV1,
  validateScaP02OperationRequestV1,
  validateScaP02OperationResultV1,
  withScaP02Digest,
} from "../dist/sca/p02-contracts.js";
import {
  SCA_P02_CANDIDATE_REGISTRATION,
  SCA_P02_CANDIDATE_PLAYBOOK_NAME,
  SCA_P02_PHASE_PLAYBOOK_NAME,
  SCA_P02_PHASE_REGISTRATION,
} from "../dist/sca/p02-playbook.js";
import { resolveScaPhaseRegistration } from "../dist/sca/phase-registry.js";
import { WorkerExecutor } from "../dist/worker.js";

const roots: string[] = [];

class NonEmptyNeverMap implements ReadonlyMap<string, never> {
  readonly size = 1;

  get(): undefined {
    return undefined;
  }

  has(): boolean {
    return false;
  }

  forEach(): void {}

  entries(): MapIterator<[string, never]> {
    return new Map<string, never>().entries();
  }

  keys(): MapIterator<string> {
    return new Map<string, never>().keys();
  }

  values(): MapIterator<never> {
    return new Map<string, never>().values();
  }

  [Symbol.iterator](): MapIterator<[string, never]> {
    return this.entries();
  }
}

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p02-candidate-"));
  roots.push(root);
  return root;
}

function ref(
  label: string,
  overrides: {
    readonly kind?: string;
    readonly schemaId?: string;
    readonly schemaVersion?: number;
    readonly producer?: string;
  } = {}
): ArtifactRef {
  const digest = sha256(label);
  return {
    schema_version: 2,
    artifact_id: `art_${digest}`,
    run_id: "p02-contract-run",
    phase: "sca-p02-candidate",
    branch_id: null,
    kind: overrides.kind ?? `p02-${label}`,
    operation_id: `p02-${label}`,
    version: 1,
    producer: overrides.producer ?? "host:sca-p02-candidate",
    media_type: "application/json",
    content_schema: {
      schema_id: overrides.schemaId ?? "penny.sca-p02-test.v1",
      schema_version: overrides.schemaVersion ?? 1,
    },
    byte_length: 2,
    content_digest: sha256("{}"),
    store_ref: `artifact://sha256/${sha256("{}")}`,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("inactive deterministic SCA P02 candidate", () => {
  it("requires six exact live profiles and their canonical aggregate without changing simulated evidence", () => {
    const operationProfiles = {
      inventory: sha256("inventory"),
      semgrep_php: sha256("semgrep_php"),
      semgrep_js_ts: sha256("semgrep_js_ts"),
      gitleaks: sha256("gitleaks"),
      osv_composer: sha256("osv_composer"),
      osv_npm: sha256("osv_npm"),
    };
    expect(new Set(Object.values(operationProfiles)).size).toBe(6);
    const profile_sha256 = scaP02AggregateProfileSha256(operationProfiles);
    const attestation = {
      schema_id: SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
      schema_version: 1,
      attestation_id: "fixture-attestation",
      runtime_kind: "host_qualified",
      isolation_id: "fixture-isolation",
      runtime_id: "fixture-runtime",
      implementation_identity_sha256: sha256("implementation"),
      deployment_identity_sha256: sha256("deployment"),
      profile_id: "fixture-profile",
      profile_sha256,
      operation_profiles: operationProfiles,
      qualification_scope: "live_qualified",
      qualified: true,
      attested_at: "2026-09-20T00:00:00.000Z",
    };
    expect(validateScaP02HostIsolationAttestationV1(attestation)).toEqual(attestation);
    const attestationDigest = sha256(canonicalJson(attestation));
    const attestationRef = {
      ...ref("host-attestation", {
        kind: SCA_P02_HOST_ATTESTATION_KIND,
        schemaId: SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
        producer: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
      }),
      content_digest: attestationDigest,
      store_ref: `artifact://sha256/${attestationDigest}`,
    };
    const evidence = {
      schema_id: SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
      schema_version: 1,
      producer_id: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
      isolation_id: attestation.isolation_id,
      runtime_id: attestation.runtime_id,
      implementation_identity_sha256: attestation.implementation_identity_sha256,
      deployment_identity_sha256: attestation.deployment_identity_sha256,
      profile_id: attestation.profile_id,
      profile_sha256,
      operation_profiles: operationProfiles,
      qualified_at: attestation.attested_at,
      evidence_kind: "host_qualification_attestation",
      runtime_kind: "host_qualified",
      qualification_scope: "live_qualified",
      qualified: true,
      host_attestation_id: attestation.attestation_id,
      host_attestation_sha256: attestationRef.content_digest,
      host_attestation_ref: attestationRef,
    };
    const validatedEvidence = validateScaP02IsolationEvidenceV1(evidence);
    expect(validatedEvidence).toEqual(evidence);
    for (const kind of [
      "inventory",
      "semgrep_php",
      "semgrep_js_ts",
      "gitleaks",
      "osv_composer",
      "osv_npm",
    ] as const) {
      expect(scaP02OperationProfileSha256(validatedEvidence, kind)).toBe(operationProfiles[kind]);
      expect(operationProfiles[kind]).not.toBe(profile_sha256);
    }
    assertScaP02HostAttestationBindingV1({
      request_ref: attestationRef,
      evidence: validateScaP02IsolationEvidenceV1(evidence),
      attestation: validateScaP02HostIsolationAttestationV1(attestation),
    });
    const swapped = {
      ...operationProfiles,
      inventory: operationProfiles.osv_npm,
      osv_npm: operationProfiles.inventory,
    };
    for (const value of [
      { ...evidence, operation_profiles: swapped },
      {
        ...evidence,
        operation_profiles: { ...operationProfiles, inventory: operationProfiles.gitleaks },
        profile_sha256: sha256(
          canonicalJson({ ...operationProfiles, inventory: operationProfiles.gitleaks })
        ),
      },
      { ...evidence, profile_sha256: sha256("wrong aggregate") },
      { ...evidence, operation_profiles: { ...operationProfiles, inventory: "bad" } },
      { ...evidence, operation_profiles: { inventory: operationProfiles.inventory } },
      { ...evidence, operation_profiles: { ...operationProfiles, unexpected: sha256("extra") } },
    ]) {
      expect(() => validateScaP02IsolationEvidenceV1(value)).toThrow();
    }
    const swappedAggregate = scaP02AggregateProfileSha256(swapped);
    expect(() =>
      assertScaP02HostAttestationBindingV1({
        request_ref: attestationRef,
        evidence: validateScaP02IsolationEvidenceV1({
          ...evidence,
          operation_profiles: swapped,
          profile_sha256: swappedAggregate,
        }),
        attestation: validateScaP02HostIsolationAttestationV1(attestation),
      })
    ).toThrow(/fields drifted/u);
    expect(() =>
      validateScaP02HostIsolationAttestationV1({ ...attestation, operation_profiles: swapped })
    ).toThrow();
    expect(() =>
      validateScaP02HostIsolationAttestationV1({
        ...attestation,
        profile_sha256: sha256("wrong aggregate"),
      })
    ).toThrow();
    const { operation_profiles: _omitted, ...withoutProfiles } = evidence;
    expect(() => validateScaP02IsolationEvidenceV1(withoutProfiles)).toThrow();
    const simulated = {
      ...withoutProfiles,
      evidence_kind: "simulated_test_seam",
      runtime_kind: "simulated_test_runtime",
      qualification_scope: "deterministic_test_only",
      qualified: false,
    };
    const {
      host_attestation_id: _id,
      host_attestation_sha256: _sha,
      host_attestation_ref: _ref,
      ...simulatedOnly
    } = simulated;
    const validatedSimulated = validateScaP02IsolationEvidenceV1(simulatedOnly);
    expect(validatedSimulated).toEqual(simulatedOnly);
    for (const kind of [
      "inventory",
      "semgrep_php",
      "semgrep_js_ts",
      "gitleaks",
      "osv_composer",
      "osv_npm",
    ] as const) {
      expect(scaP02OperationProfileSha256(validatedSimulated, kind)).toBe(profile_sha256);
    }
    expect(() =>
      validateScaP02IsolationEvidenceV1({ ...simulatedOnly, operation_profiles: operationProfiles })
    ).toThrow();
  });
  it("keeps candidate and accepted-phase registrations outside the user-facing product registry", () => {
    expect(resolvePlaybook(SCA_P02_CANDIDATE_PLAYBOOK_NAME)).toBeUndefined();
    expect(resolvePlaybook(SCA_P02_PHASE_PLAYBOOK_NAME)).toBeUndefined();
    expect(resolvePlaybook("sca")?.name).toBe("sca");
    expect(resolveScaPhaseRegistration(SCA_P02_PHASE_PLAYBOOK_NAME)).toBe(
      SCA_P02_PHASE_REGISTRATION
    );
    for (const registration of [SCA_P02_CANDIDATE_REGISTRATION, SCA_P02_PHASE_REGISTRATION]) {
      expect(() => validateRegistrationContract(registration)).not.toThrow();
      expect(runtimeRegistrationSha256(registration)).toBe(runtimeRegistrationSha256(registration));
      expect(registration.worker).toMatchObject({ kind: "none" });
      expect(registration.worker.phases.size).toBe(0);
    }
    expect(runtimeRegistrationSha256(SCA_P02_PHASE_REGISTRATION)).not.toBe(
      runtimeRegistrationSha256(SCA_P02_CANDIDATE_REGISTRATION)
    );
  });

  it("refuses production playbook construction without host component authority", () => {
    const root = temporaryRoot();
    using artifacts = ArtifactStore.provision(path.join(root, "artifacts"), {
      projectId: "prj_33333333333333333333333333333333",
    });
    expect(() => SCA_P02_CANDIDATE_REGISTRATION.construct({ artifactStore: artifacts })).toThrow(
      /host-owned component validation authority/u
    );
  });

  it("rejects invalid none-worker phases and blocks before model-client reachability", async () => {
    const invalid = {
      ...SCA_P02_CANDIDATE_REGISTRATION,
      worker: {
        ...SCA_P02_CANDIDATE_REGISTRATION.worker,
        phases: new NonEmptyNeverMap(),
      },
    };
    expect(() => validateRegistrationContract(invalid)).toThrow(/must declare zero phases/u);

    const reachability = {
      catalog_calls: 0,
      prompt_catalog_calls: 0,
      provider_calls: 0,
      session_creations: 0,
      model_calls: 0,
    };
    const model: ModelClient = {
      async runAgent() {
        reachability.catalog_calls += 1;
        reachability.prompt_catalog_calls += 1;
        reachability.provider_calls += 1;
        reachability.session_creations += 1;
        reachability.model_calls += 1;
        throw new Error("model client must be unreachable");
      },
    };
    const root = temporaryRoot();
    using artifacts = ArtifactStore.provision(path.join(root, "artifacts"), {
      projectId: "prj_22222222222222222222222222222222",
    });
    const worker = new WorkerExecutor(model, artifacts, {
      projectRoot: root,
      parallelConcurrency: 1,
      registration: SCA_P02_CANDIDATE_REGISTRATION,
    });
    const directive = validateDirective({
      schema_version: 2,
      action: "invoke_agent",
      identity: {
        schema_version: 2,
        run_id: "p02-none-worker-run",
        session_id: "p02-none-worker-session",
        playbook: SCA_P02_CANDIDATE_PLAYBOOK_NAME,
        engine_owner: "typescript",
      },
      state_id: "forbidden-worker-state",
      agent: "forbidden-agent",
      attempt: 1,
      trust_profile: "hardened-untrusted",
      task: "This must be rejected before any worker dependency is reached.",
      input_artifacts: { schema_version: 2, artifacts: [] },
      output_artifact: {
        schema_version: 2,
        run_id: "p02-none-worker-run",
        phase: "forbidden-worker-state",
        branch_id: null,
        kind: "forbidden-output",
        operation_id: "forbidden-output",
        version: 1,
        producer: "agent:forbidden-agent",
        media_type: "application/json",
        content_schema: { schema_id: "penny.forbidden-output.v1", schema_version: 1 },
        parent_ref: null,
        upstream_refs: [],
      },
    });
    await expect(worker.execute(directive)).rejects.toThrow(/cannot enter the worker runtime/u);
    expect(reachability).toEqual({
      catalog_calls: 0,
      prompt_catalog_calls: 0,
      provider_calls: 0,
      session_creations: 0,
      model_calls: 0,
    });
  });

  it("keeps OSV requests coordinate-only and rejects unknown source/path fields", () => {
    const unsigned = {
      schema_id: SCA_P02_OSV_NPM_REQUEST_V1_SCHEMA,
      schema_version: 1 as const,
      run_id: "p02-contract-run",
      operation_id: SCA_P02_OPERATION_IDS.osv_npm,
      operation_kind: "osv_npm" as const,
      ecosystem: "npm" as const,
      p01_binding_sha256: "1".repeat(64),
      p02_request_ref: ref("candidate-request", {
        kind: "sca-p02-candidate-request",
        schemaId: "penny.sca-p02-request.v1",
      }),
      runtime_policy_ref: ref("runtime-policy", {
        kind: "sca-p02-runtime-policy",
        schemaId: "penny.sca-p02-runtime-policy.v1",
        producer: "host:sca-p02-runtime-policy",
      }),
      isolation_evidence_ref: ref("isolation-evidence", {
        kind: "sca-p02-isolation-evidence",
        schemaId: "penny.sca-p02-isolation-evidence.v1",
        producer: "host:sca-p02-isolation-qualification",
      }),
      isolation_id: "test-isolation",
      isolation_runtime_id: "test-runtime",
      isolation_runtime_kind: "simulated_test_runtime" as const,
      isolation_qualification_scope: "deterministic_test_only" as const,
      isolation_profile_id: "test-profile",
      isolation_profile_sha256: "2".repeat(64),
      isolation_implementation_sha256: "3".repeat(64),
      isolation_deployment_sha256: "4".repeat(64),
      isolation_host_attestation_id: null,
      isolation_host_attestation_sha256: null,
      isolation_host_attestation_ref: null,
      coordinates: [
        {
          query_id: `depcoord_${"3".repeat(64)}`,
          package: { ecosystem: "npm" as const, name: "example", version: "1.0.0" },
        },
      ],
      mappings: [
        {
          query_id: `depcoord_${"3".repeat(64)}`,
          occurrence_id: `depocc_${"4".repeat(64)}`,
          package: { ecosystem: "npm" as const, name: "example", version: "1.0.0" },
        },
      ],
      transport_id: "deterministic-osv-transport",
      max_batch_size: 128,
      max_concurrency: 2,
      timeout_ms: 10_000,
      max_response_bytes: 1_048_576,
      max_advisory_requests: 32,
      freshness_max_age_seconds: 3_600,
    };
    const request = withScaP02Digest(unsigned, "request_sha256");
    expect(validateScaP02OperationRequestV1("osv_npm", request)).toEqual(request);
    const unexpectedHostAttestation = withScaP02Digest(
      {
        ...unsigned,
        isolation_host_attestation_ref: ref("unexpected-host-attestation", {
          kind: "sca-p02-host-isolation-attestation",
          schemaId: "penny.sca-p02-host-isolation-attestation.v1",
          producer: "host:sca-p02-isolation-qualification",
        }),
      },
      "request_sha256"
    );
    expect(() => validateScaP02OperationRequestV1("osv_npm", unexpectedHostAttestation)).toThrow(
      /attestation binding is inconsistent/u
    );
    expect(() =>
      validateScaP02OperationRequestV1("osv_npm", {
        ...request,
        source_root: "/forbidden/source",
      })
    ).toThrow(/additional properties/u);
  });

  it("rejects empty, contradictory, noncanonical, or identity-drifted analyzer evidence", () => {
    const request = validateScaP02OperationRequestV1(
      "semgrep_php",
      withScaP02Digest(
        {
          schema_id: SCA_P02_SEMGREP_PHP_REQUEST_V1_SCHEMA,
          schema_version: 1,
          run_id: "p02-contract-run",
          operation_id: SCA_P02_OPERATION_IDS.semgrep_php,
          operation_kind: "semgrep_php" as const,
          p01_binding_sha256: "1".repeat(64),
          p02_request_ref: ref("candidate-request", {
            kind: "sca-p02-candidate-request",
            schemaId: "penny.sca-p02-request.v1",
          }),
          runtime_policy_ref: ref("runtime-policy", {
            kind: "sca-p02-runtime-policy",
            schemaId: "penny.sca-p02-runtime-policy.v1",
            producer: "host:sca-p02-runtime-policy",
          }),
          isolation_evidence_ref: ref("isolation-evidence", {
            kind: "sca-p02-isolation-evidence",
            schemaId: "penny.sca-p02-isolation-evidence.v1",
            producer: "host:sca-p02-isolation-qualification",
          }),
          isolation_id: "test-isolation",
          isolation_runtime_id: "test-runtime",
          isolation_runtime_kind: "simulated_test_runtime" as const,
          isolation_qualification_scope: "deterministic_test_only" as const,
          isolation_profile_id: "test-profile",
          isolation_profile_sha256: "2".repeat(64),
          isolation_implementation_sha256: "3".repeat(64),
          isolation_deployment_sha256: "4".repeat(64),
          isolation_host_attestation_id: null,
          isolation_host_attestation_sha256: null,
          isolation_host_attestation_ref: null,
          source_snapshot_ref: {
            ...ref("source-snapshot", {
              kind: "source-snapshot",
              schemaId: "penny.sca-campaign-source-snapshot.v2",
              schemaVersion: 2,
            }),
            content_digest: "5".repeat(64),
            store_ref: `artifact://sha256/${"5".repeat(64)}`,
          },
          source_snapshot_sha256: "5".repeat(64),
          staging_parent: "/tmp/p02-contract-test",
          executable: {
            tool_id: "semgrep-test",
            executable_path: "/tmp/semgrep-test",
            executable_sha256: "6".repeat(64),
            version: "1",
          },
          timeout_ms: 1_000,
          max_output_bytes: 1_024,
          languages: ["php"] as const,
          selected_rule_bindings: [{ rule_id: "semgrep-rule", content_sha256: "7".repeat(64) }],
          excluded_rule_ids: [],
        },
        "request_sha256"
      )
    );
    if (request.operation_kind !== "semgrep_php") throw new Error("unexpected request kind");
    const value = {
      schema_id: "penny.sca-p02-adapter-blocker.v1",
      schema_version: 1,
      operation_kind: "semgrep_php",
      blocker_codes: ["scanner_failed"],
    } as const;
    const bundle = buildScaP02RawEvidenceV1({ analyzer_id: "semgrep-php", value });
    const graph = buildScaP02ProvenanceV1({
      raw_evidence: [bundle.evidence],
      raw_records: bundle.raw_records,
      candidates: [],
    });
    const result = {
      schema_id: SCA_P02_SEMGREP_PHP_RESULT_V1_SCHEMA,
      schema_version: 1 as const,
      run_id: request.run_id,
      operation_id: request.operation_id,
      operation_kind: "semgrep_php" as const,
      request_sha256: request.request_sha256,
      source_binding_sha256: request.source_snapshot_sha256,
      isolation_id: request.isolation_id,
      isolation_runtime_id: request.isolation_runtime_id,
      isolation_runtime_kind: request.isolation_runtime_kind,
      isolation_qualification_scope: request.isolation_qualification_scope,
      isolation_profile_id: request.isolation_profile_id,
      isolation_profile_sha256: request.isolation_profile_sha256,
      isolation_implementation_sha256: request.isolation_implementation_sha256,
      isolation_deployment_sha256: request.isolation_deployment_sha256,
      isolation_host_attestation_id: request.isolation_host_attestation_id,
      isolation_host_attestation_sha256: request.isolation_host_attestation_sha256,
      isolation_host_attestation_ref: request.isolation_host_attestation_ref,
      status: "blocked" as const,
      analyzer_results: [
        {
          analyzer_id: "semgrep-php" as const,
          applicability: "applicable" as const,
          status: "blocked" as const,
          fresh: false,
          blocker_codes: ["scanner_failed"],
        },
      ],
      raw_evidence: [bundle.evidence],
      raw_records: [...bundle.raw_records],
      normalized_observations: [...graph.normalized_observations],
      correlations: [...graph.correlations],
      freshness: { fetched_at: null, max_age_seconds: null, expires_at: null },
      completed_at: "2026-09-20T00:00:00.000Z",
    };
    expect(validateScaP02OperationResultV1("semgrep_php", request, result)).toEqual(result);
    expect(() =>
      validateScaP02OperationResultV1("semgrep_php", request, {
        ...result,
        raw_evidence: [],
        raw_records: [],
        correlations: [],
      })
    ).toThrow();
    expect(() =>
      validateScaP02OperationResultV1("semgrep_php", request, {
        ...result,
        status: "complete",
        analyzer_results: [
          {
            ...result.analyzer_results[0],
            status: "complete",
            fresh: true,
            blocker_codes: [],
          },
        ],
      })
    ).toThrow(/contradicts canonical raw semantics/u);

    const noncanonical = JSON.stringify(value, null, 2);
    const noncanonicalSha = sha256(noncanonical);
    expect(() =>
      validateScaP02OperationResultV1("semgrep_php", request, {
        ...result,
        raw_evidence: [
          {
            ...bundle.evidence,
            evidence_id: `p02e_${sha256(
              canonicalJson({ analyzer_id: "semgrep-php", content_sha256: noncanonicalSha })
            )}`,
            content_base64: Buffer.from(noncanonical, "utf8").toString("base64"),
            content_sha256: noncanonicalSha,
            byte_length: Buffer.byteLength(noncanonical, "utf8"),
          },
        ],
      })
    ).toThrow(/not canonical JSON/u);
    expect(() =>
      validateScaP02OperationResultV1("semgrep_php", request, {
        ...result,
        raw_evidence: [{ ...bundle.evidence, evidence_id: `p02e_${"f".repeat(64)}` }],
      })
    ).toThrow(/identity is invalid/u);
  });

  it("fails closed on duplicate/incomplete coverage, stale evidence, and positive M1 claims", () => {
    const operationByAnalyzer = (analyzerId: (typeof SCA_P02_ANALYZER_IDS)[number]) => {
      if (
        analyzerId.startsWith("source-") ||
        analyzerId.startsWith("tree-") ||
        analyzerId.startsWith("dependency-")
      )
        return "inventory" as const;
      if (analyzerId === "semgrep-php") return "semgrep_php" as const;
      if (analyzerId === "semgrep-js-ts") return "semgrep_js_ts" as const;
      if (analyzerId === "gitleaks") return "gitleaks" as const;
      return analyzerId === "osv-composer" ? ("osv_composer" as const) : ("osv_npm" as const);
    };
    const resultSchemaByOperation = {
      inventory: SCA_P02_INVENTORY_RESULT_V1_SCHEMA,
      semgrep_php: SCA_P02_SEMGREP_PHP_RESULT_V1_SCHEMA,
      semgrep_js_ts: SCA_P02_SEMGREP_JS_TS_RESULT_V1_SCHEMA,
      gitleaks: SCA_P02_GITLEAKS_RESULT_V1_SCHEMA,
      osv_composer: SCA_P02_OSV_COMPOSER_RESULT_V1_SCHEMA,
      osv_npm: SCA_P02_OSV_NPM_RESULT_V1_SCHEMA,
    } as const;
    const entries = SCA_P02_ANALYZER_IDS.map((analyzerId) => {
      const operationKind = operationByAnalyzer(analyzerId);
      return {
        analyzer_id: analyzerId,
        operation_kind: operationKind,
        applicability: "applicable" as const,
        status: "complete" as const,
        fresh: true,
        blocker_codes: [],
        operation_result_ref: ref(`${analyzerId}-result`, {
          kind: `sca-p02-${operationKind.replaceAll("_", "-")}-result`,
          schemaId: resultSchemaByOperation[operationKind],
        }),
        normalized_evidence_ref: ref(`${analyzerId}-evidence`, {
          kind: "sca-p02-persisted-evidence",
          schemaId: SCA_P02_PERSISTED_EVIDENCE_V1_SCHEMA,
        }),
      };
    });
    const matrix = withScaP02Digest(
      {
        schema_id: SCA_P02_COVERAGE_MATRIX_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: "p02-contract-run",
        p01_binding_sha256: "5".repeat(64),
        entries,
      },
      "coverage_sha256"
    );
    expect(validateScaP02CoverageMatrixV1(matrix)).toEqual(matrix);
    const duplicateEntry = entries[8];
    if (duplicateEntry === undefined) throw new Error("coverage fixture lacks duplicate entry");
    expect(() =>
      validateScaP02CoverageMatrixV1(
        withScaP02Digest(
          { ...matrix, entries: [...entries.slice(0, 9), duplicateEntry] },
          "coverage_sha256"
        )
      )
    ).toThrow(/exact ordered analyzer set/u);

    const coverageRef = ref("coverage", {
      kind: "sca-p02-coverage-matrix",
      schemaId: SCA_P02_COVERAGE_MATRIX_V1_SCHEMA,
    });
    const invalidGate = withScaP02Digest(
      {
        schema_id: SCA_P02_GATE_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: "p02-contract-run",
        coverage_matrix_ref: coverageRef,
        status: "passed" as const,
        blocker_codes: [],
        evaluated_at: "2026-09-20T00:00:00.000Z",
      },
      "gate_sha256"
    );
    expect(() => validateScaP02GateV1(invalidGate)).toThrow();

    expect(() =>
      validateScaM1RecordV2(
        withScaP02Digest(
          {
            schema_id: SCA_M1_RECORD_V2_SCHEMA,
            schema_version: 2 as const,
            run_id: "p02-contract-run",
            phase_id: "SCA-P02" as const,
            gate_ref: ref("gate"),
            coverage_matrix_ref: coverageRef,
            status: "passed" as const,
            nonterminal: true as const,
            release_eligible: true,
            campaign_terminal: false as const,
            model_calls: 0 as const,
            model_turns: 0 as const,
            blocker_codes: [],
            transition_authorized: true,
            recorded_at: "2026-09-20T00:00:00.000Z",
          },
          "record_sha256"
        )
      )
    ).toThrow();
  });
});
