import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract, type ArtifactRef } from "../../orchestration/dist/contracts.js";
import type {
  HostOperationExecutionContextV1,
  HostOperationPersistedOutputV1,
} from "../../orchestration/dist/host-operations/contracts.js";
import {
  SCA_P02_CANDIDATE_PRODUCER,
  SCA_P02_CANDIDATE_REQUEST_KIND,
  SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
  SCA_P02_INPUT_SLOTS,
  scaP02AggregateProfileSha256,
  SCA_P02_HOST_ATTESTATION_KIND,
  SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
  SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
  SCA_P02_OPERATION_IDS,
  SCA_P02_OSV_NPM_REQUEST_V1_SCHEMA,
  SCA_P02_OSV_COMPOSER_REQUEST_V1_SCHEMA,
  SCA_P02_REQUEST_V1_SCHEMA,
  SCA_P02_RUNTIME_POLICY_PRODUCER,
  SCA_P02_RUNTIME_POLICY_V1_SCHEMA,
  SCA_P02_SEMGREP_PHP_REQUEST_V1_SCHEMA,
  ScaP02SemgrepPhpResultV1Schema,
  buildScaP02ProvenanceV1,
  buildScaP02RawEvidenceV1,
  deriveScaP02ProvenanceV1,
  validateScaP02OperationRequestV1,
  validateScaP02OperationResultV1,
  withScaP02Digest,
  type ScaP02OperationKind,
} from "../../orchestration/dist/sca/p02-contracts.js";
import { SCA_P02_OPERATION_DECLARATIONS } from "../../orchestration/dist/sca/p02-playbook.js";
import { scaDependencyCoordinateIdV2 } from "../src/adapters/dependency-inventory-v2.js";
import {
  createScaP02OperationAdaptersV1 as createScaP02OperationAdaptersWithoutAuthorityV1,
  type ScaP02OperationAdapterOptionsV1,
} from "../src/p02-operations.js";
import { p02TestOperationEnvelope } from "./p02-test-context.js";

// Test-only issuer seam. The production matcher still uses its private factory WeakMap.
const osvIssuer = vi.hoisted(() => ({ current: null as object | null }));
vi.mock("../src/p02-osv-host.js", async (originalImport) => {
  const original = await originalImport<typeof import("../src/p02-osv-host.js")>();
  return {
    ...original,
    matchesIssuedP02OsvTransport: (
      ...args: Parameters<typeof original.matchesIssuedP02OsvTransport>
    ) => args[0] === osvIssuer.current || original.matchesIssuedP02OsvTransport(...args),
  };
});
afterEach(() => {
  osvIssuer.current = null;
});
import {
  createP02HostProcessRunnerV1,
  isControlledP02RunnerV1,
  isControlledP02FactoryRunnerV1,
} from "../src/p02-host-process-runner.js";

const FIXED_NOW = new Date("2026-09-20T00:00:00.000Z");
const TEST_COMPONENT_VALIDATION_AUTHORITY = Object.freeze({
  validateComponents(): void {},
});

function createScaP02OperationAdaptersV1(options: ScaP02OperationAdapterOptionsV1 = {}) {
  return createScaP02OperationAdaptersWithoutAuthorityV1({
    ...options,
    component_validation_authority: TEST_COMPONENT_VALIDATION_AUTHORITY,
  });
}

function artifactRef(kind: string, schemaId: string, content: string): ArtifactRef {
  const digest = sha256(content);
  return {
    schema_version: 2,
    artifact_id: `art_${sha256(`${kind}:${digest}`)}`,
    run_id: "p02-failclosed-fixture",
    phase: "fixture",
    branch_id: null,
    kind,
    operation_id: kind,
    version: 1,
    producer: "host:fixture",
    media_type: "application/json",
    content_schema: { schema_id: schemaId, schema_version: 1 },
    byte_length: Buffer.byteLength(content, "utf8"),
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function context(input: {
  readonly kind: ScaP02OperationKind;
  readonly request: object;
  readonly signal?: AbortSignal;
  readonly capture: (content: string) => void;
  readonly onRead?: () => void;
  readonly lifecycle?: "lease_acquired" | "submitted" | "fetched" | "persisting";
  readonly cachedBytes?: Uint8Array;
  readonly isolationEvidenceBytes?: string;
}): HostOperationExecutionContextV1 {
  const declaration = SCA_P02_OPERATION_DECLARATIONS[input.kind];
  const requestBytes = canonicalJson(input.request);
  const request = validateScaP02OperationRequestV1(input.kind, input.request);
  const envelope = p02TestOperationEnvelope({
    declaration,
    requestBytes,
    requestSha256: request.request_sha256,
    lifecycle: input.lifecycle ?? "lease_acquired",
    createdAt: FIXED_NOW.toISOString(),
  });
  let journal = envelope.journal;
  return {
    directive: envelope.directive,
    get journal() {
      return structuredClone(journal);
    },
    declaration,
    request_bytes: Buffer.from(requestBytes, "utf8"),
    signal: input.signal ?? new AbortController().signal,
    reportActivity() {},
    readInput(slot) {
      input.onRead?.();
      if (
        slot === SCA_P02_INPUT_SLOTS.isolation_evidence &&
        input.isolationEvidenceBytes !== undefined
      ) {
        return {
          ref: request.isolation_evidence_ref,
          bytes: Buffer.from(input.isolationEvidenceBytes),
        };
      }
      throw new Error("fail-closed fixture must not read an artifact");
    },
    emitProgress() {},
    beginSubmission() {
      expect(journal.lifecycle).toBe("lease_acquired");
      journal = { ...journal, lifecycle: "submitting" };
    },
    recordRemoteAccepted(correlationId) {
      expect(journal.lifecycle).toBe("submitting");
      journal = {
        ...journal,
        lifecycle: "submitted",
        remote_correlation_id: correlationId,
        remote_correlation_sha256: sha256(correlationId),
      };
    },
    async cacheResult(bytes) {
      return {
        schema_version: 1 as const,
        request_sha256: request.request_sha256,
        content_sha256: sha256(bytes),
        byte_length: bytes.byteLength,
        bytes: Buffer.from(bytes),
      };
    },
    async readCachedResult() {
      if (input.cachedBytes === undefined) return null;
      return {
        schema_version: 1 as const,
        request_sha256: request.request_sha256,
        content_sha256: sha256(input.cachedBytes),
        byte_length: input.cachedBytes.byteLength,
        bytes: Buffer.from(input.cachedBytes),
      };
    },
    recordFetched() {
      expect(["submitted", "fetched"]).toContain(journal.lifecycle);
      journal = { ...journal, lifecycle: "fetched" };
    },
    persist(persistence): HostOperationPersistedOutputV1 {
      const content = String(persistence.operation_result.content);
      input.capture(content);
      return {
        operation_result_ref: artifactRef(
          declaration.result.artifact_kind,
          declaration.result.schema_id,
          content
        ),
        output_artifacts: [],
      };
    },
    registerRemoteCancellation() {},
  };
}

function boundRef(input: {
  readonly kind: string;
  readonly schemaId: string;
  readonly producer: string;
  readonly digest: string;
  readonly schemaVersion?: number;
}): ArtifactRef {
  return {
    schema_version: 2,
    artifact_id: `art_${input.digest}`,
    run_id: "p02-failclosed-fixture",
    phase: "fixture",
    branch_id: null,
    kind: input.kind,
    operation_id: input.kind,
    version: 1,
    producer: input.producer,
    media_type: "application/json",
    content_schema: {
      schema_id: input.schemaId,
      schema_version: input.schemaVersion ?? 1,
    },
    byte_length: 2,
    content_digest: input.digest,
    store_ref: `artifact://sha256/${input.digest}`,
  };
}

function operationAuthorityBindings() {
  return {
    p02_request_ref: boundRef({
      kind: SCA_P02_CANDIDATE_REQUEST_KIND,
      schemaId: SCA_P02_REQUEST_V1_SCHEMA,
      producer: SCA_P02_CANDIDATE_PRODUCER,
      digest: "3".repeat(64),
    }),
    runtime_policy_ref: boundRef({
      kind: "sca-p02-runtime-policy",
      schemaId: SCA_P02_RUNTIME_POLICY_V1_SCHEMA,
      producer: SCA_P02_RUNTIME_POLICY_PRODUCER,
      digest: "4".repeat(64),
    }),
    isolation_evidence_ref: boundRef({
      kind: "sca-p02-isolation-evidence",
      schemaId: SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
      producer: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
      digest: "5".repeat(64),
    }),
  };
}

const LIVE_PROFILES = Object.freeze({
  inventory: sha256("inventory-profile"),
  semgrep_php: sha256("semgrep-php-profile"),
  semgrep_js_ts: sha256("semgrep-js-ts-profile"),
  gitleaks: sha256("gitleaks-profile"),
  osv_composer: sha256("osv-composer-profile"),
  osv_npm: sha256("osv-npm-profile"),
});
const LIVE_AGGREGATE = scaP02AggregateProfileSha256(LIVE_PROFILES);

function liveSemgrepFixture() {
  const original = semgrepRequest();
  const attestation = boundRef({
    kind: SCA_P02_HOST_ATTESTATION_KIND,
    schemaId: SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
    producer: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
    digest: "9".repeat(64),
  });
  const evidenceBytes = canonicalJson({
    schema_id: SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
    schema_version: 1,
    producer_id: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
    isolation_id: original.isolation_id,
    runtime_id: original.isolation_runtime_id,
    implementation_identity_sha256: original.isolation_implementation_sha256,
    deployment_identity_sha256: original.isolation_deployment_sha256,
    profile_id: original.isolation_profile_id,
    profile_sha256: LIVE_AGGREGATE,
    operation_profiles: LIVE_PROFILES,
    qualified_at: FIXED_NOW.toISOString(),
    evidence_kind: "host_qualification_attestation",
    runtime_kind: "host_qualified",
    qualification_scope: "live_qualified",
    qualified: true,
    host_attestation_id: "fixture-attestation",
    host_attestation_sha256: attestation.content_digest,
    host_attestation_ref: attestation,
  });
  const digest = sha256(evidenceBytes);
  const isolationRef = {
    ...original.isolation_evidence_ref,
    artifact_id: `art_${digest}`,
    content_digest: digest,
    byte_length: Buffer.byteLength(evidenceBytes),
    store_ref: `artifact://sha256/${digest}`,
  };
  const live = validateScaP02OperationRequestV1(
    "semgrep_php",
    withScaP02Digest(
      {
        ...original,
        isolation_evidence_ref: isolationRef,
        isolation_profile_sha256: LIVE_PROFILES.semgrep_php,
        isolation_runtime_kind: "host_qualified",
        isolation_qualification_scope: "live_qualified",
        isolation_host_attestation_id: "fixture-attestation",
        isolation_host_attestation_sha256: attestation.content_digest,
        isolation_host_attestation_ref: attestation,
      },
      "request_sha256"
    )
  );
  if (live.operation_kind !== "semgrep_php") throw new Error("unexpected operation kind");
  const isolation = {
    isolation_id: live.isolation_id,
    runtime_id: live.isolation_runtime_id,
    runtime_kind: "host_qualified" as const,
    qualification_scope: "live_qualified" as const,
    implementation_identity_sha256: live.isolation_implementation_sha256,
    deployment_identity_sha256: live.isolation_deployment_sha256,
    profile_id: live.isolation_profile_id,
    profile_sha256: LIVE_AGGREGATE,
    operation_profiles: LIVE_PROFILES,
    host_attestation_id: "fixture-attestation",
    host_attestation_sha256: attestation.content_digest,
    host_attestation_ref: attestation,
    run: async <T>({ execute }: { execute: () => Promise<T> }): Promise<T> => execute(),
  };
  return { live, isolation, evidenceBytes };
}

function semgrepRequest() {
  const sourceSnapshotSha256 = "c".repeat(64);
  const request = validateScaP02OperationRequestV1(
    "semgrep_php",
    withScaP02Digest(
      {
        schema_id: SCA_P02_SEMGREP_PHP_REQUEST_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: "p02-failclosed-fixture",
        operation_id: SCA_P02_OPERATION_IDS.semgrep_php,
        operation_kind: "semgrep_php" as const,
        p01_binding_sha256: "a".repeat(64),
        ...operationAuthorityBindings(),
        isolation_id: "test-isolation",
        isolation_runtime_id: "test-runtime",
        isolation_runtime_kind: "simulated_test_runtime" as const,
        isolation_qualification_scope: "deterministic_test_only" as const,
        isolation_profile_id: "test-profile",
        isolation_profile_sha256: "b".repeat(64),
        isolation_implementation_sha256: "1".repeat(64),
        isolation_deployment_sha256: "2".repeat(64),
        isolation_host_attestation_id: null,
        isolation_host_attestation_sha256: null,
        isolation_host_attestation_ref: null,
        source_snapshot_ref: boundRef({
          kind: "source-snapshot",
          schemaId: "penny.sca-campaign-source-snapshot.v2",
          schemaVersion: 2,
          producer: "host:fixture",
          digest: sourceSnapshotSha256,
        }),
        source_snapshot_sha256: sourceSnapshotSha256,
        staging_parent: "/not-materialized",
        executable: {
          tool_id: "semgrep",
          executable_path: "/not-executed/semgrep",
          executable_sha256: "d".repeat(64),
          version: "1.0.0",
        },
        timeout_ms: 1_000,
        max_output_bytes: 65_536,
        languages: ["php"] as const,
        excluded_rule_ids: ["gitleaks-configuration"],
        selected_rule_bindings: [{ rule_id: "semgrep-rule", content_sha256: "e".repeat(64) }],
      },
      "request_sha256"
    )
  );
  if (request.operation_kind !== "semgrep_php") {
    throw new Error("Semgrep PHP fixture request did not narrow");
  }
  return request;
}

function semgrepResult(findings: readonly Readonly<Record<string, unknown>>[]) {
  const request = semgrepRequest();
  const stdout = canonicalJson({ results: findings, errors: [] });
  const component = {
    schema_id: "penny.sca-semgrep-result.v1",
    schema_version: 1,
    source_snapshot_sha256: request.source_snapshot_sha256,
    rule_config_sha256: request.selected_rule_bindings[0]?.content_sha256,
    status: findings.length === 0 ? "succeeded" : "findings",
    tool_version: request.executable.version,
    runtime_identity: request.executable.tool_id,
    runtime_sha256: sha256(canonicalJson(request.executable)),
    invocation_sha256: "f".repeat(64),
    exit_code: findings.length === 0 ? 0 : 1,
    finding_count: findings.length,
    engine_error_count: 0,
    raw_stdout: stdout,
    raw_stderr: "",
    raw_stdout_sha256: sha256(stdout),
    raw_stderr_sha256: sha256(""),
    truncated: false,
    error_code: "none",
  } as const;
  const bundle = buildScaP02RawEvidenceV1({
    analyzer_id: "semgrep-php",
    value: component,
  });
  const provenance = deriveScaP02ProvenanceV1({
    raw_evidence: [bundle.evidence],
    raw_records: bundle.raw_records,
  });
  const result = {
    schema_id: "penny.sca-p02-semgrep-php-result.v1",
    schema_version: 1,
    run_id: request.run_id,
    operation_id: request.operation_id,
    operation_kind: request.operation_kind,
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
    status: "complete",
    analyzer_results: [
      {
        analyzer_id: "semgrep-php",
        applicability: "applicable",
        status: "complete",
        fresh: true,
        blocker_codes: [],
      },
    ],
    raw_evidence: [bundle.evidence],
    raw_records: bundle.raw_records,
    ...provenance,
    freshness: { fetched_at: null, max_age_seconds: null, expires_at: null },
    completed_at: FIXED_NOW.toISOString(),
  } as const;
  return { request, result };
}

function osvRequest() {
  const packageValue = { ecosystem: "npm" as const, name: "lodash", version: "4.17.21" };
  const queryId = scaDependencyCoordinateIdV2("npm", packageValue.name, packageValue.version);
  const occurrenceId = `depocc_${"f".repeat(64)}`;
  return withScaP02Digest(
    {
      schema_id: SCA_P02_OSV_NPM_REQUEST_V1_SCHEMA,
      schema_version: 1 as const,
      run_id: "p02-failclosed-fixture",
      operation_id: SCA_P02_OPERATION_IDS.osv_npm,
      operation_kind: "osv_npm" as const,
      p01_binding_sha256: "a".repeat(64),
      ...operationAuthorityBindings(),
      isolation_id: "test-isolation",
      isolation_runtime_id: "test-runtime",
      isolation_runtime_kind: "simulated_test_runtime" as const,
      isolation_qualification_scope: "deterministic_test_only" as const,
      isolation_profile_id: "test-profile",
      isolation_profile_sha256: "b".repeat(64),
      isolation_implementation_sha256: "1".repeat(64),
      isolation_deployment_sha256: "2".repeat(64),
      isolation_host_attestation_id: null,
      isolation_host_attestation_sha256: null,
      isolation_host_attestation_ref: null,
      coordinates: [{ query_id: queryId, package: packageValue }],
      mappings: [{ query_id: queryId, occurrence_id: occurrenceId, package: packageValue }],
      transport_id: "externally-confined-osv",
      max_batch_size: 128,
      max_concurrency: 2,
      timeout_ms: 1_000,
      max_response_bytes: 65_536,
      max_advisory_requests: 8,
      freshness_max_age_seconds: 3_600,
      ecosystem: "npm" as const,
    },
    "request_sha256"
  );
}

describe("SCA P02 host operation fail-closed behavior", () => {
  it("distinguishes a fresh live-journal submission from prior work without asking for recovery proof", async () => {
    let proofs = 0;
    for (const kind of ["semgrep_php", "osv_npm"] as const) {
      let persisted = "";
      const adapter = createScaP02OperationAdaptersV1({
        local_recovery: {
          prove_prior_process_terminated() {
            proofs += 1;
            return false;
          },
        },
        now: () => FIXED_NOW,
      }).get(`sca-p02-${kind.replaceAll("_", "-")}-adapter-v1`);
      if (adapter === undefined) throw new Error("fresh adapter absent");
      const execution = context({
        kind,
        request: kind === "semgrep_php" ? semgrepRequest() : osvRequest(),
        capture: (bytes) => {
          persisted = bytes;
        },
      });
      const before = execution.journal;
      const result = await adapter.run(execution);
      expect(before.lifecycle).toBe("lease_acquired");
      expect(execution.journal.lifecycle).toBe("fetched");
      expect(execution.journal.remote_correlation_id).toMatch(/^p02_[a-f0-9]{64}$/u);
      expect(persisted.length).toBeGreaterThan(0);
      expect(result.disposition.outcome).toBe("completed");
      expect(proofs).toBe(0);
    }
  });

  it("refuses changed resumed correlation identity before proof, isolation, or persistence", async () => {
    let effects = 0;
    const adapter = createScaP02OperationAdaptersV1({
      local_recovery: {
        prove_prior_process_terminated() {
          effects += 1;
          return true;
        },
      },
    }).get("sca-p02-semgrep-php-adapter-v1");
    if (adapter === undefined) throw new Error("resumed adapter absent");
    const execution = context({
      kind: "semgrep_php",
      request: semgrepRequest(),
      lifecycle: "submitted",
      onRead: () => {
        effects += 1;
      },
      capture: () => {
        effects += 1;
      },
    });
    for (const patch of [
      { remote_correlation_id: "p02_wrong" },
      { remote_correlation_sha256: "0".repeat(64) },
    ]) {
      await expect(
        adapter.run({
          ...execution,
          get journal() {
            return { ...execution.journal, ...patch };
          },
        })
      ).rejects.toThrow("host operation journal cannot resume this deterministic adapter");
    }
    expect(effects).toBe(0);
  });
  it("derives and enforces the complete Semgrep provenance graph from decoded component evidence", () => {
    const finding = {
      check_id: "semgrep-rule",
      path: "src/example.php",
      start: { line: 7 },
      extra: { message: "unsafe flow" },
    };
    const { request, result } = semgrepResult([finding, finding]);
    const accepted = validateScaP02OperationResultV1("semgrep_php", request, result);
    expect(accepted.normalized_observations).toHaveLength(1);
    expect(accepted.normalized_observations[0]?.raw_record_ids).toHaveLength(2);
    expect(accepted.normalized_observations[0]?.duplicate_group_id).toMatch(/^p02dup_/u);

    const forgedGraph = buildScaP02ProvenanceV1({
      raw_evidence: result.raw_evidence,
      raw_records: result.raw_records,
      candidates: [
        {
          analyzer_id: "semgrep-php",
          category: "caller-invented",
          severity: "critical",
          subject: "caller supplied semantics",
          path: "src/example.php",
          start_line: 7,
          advisory_id: null,
          raw_record_ids: result.raw_records.map((record) => record.raw_record_id),
        },
      ],
    });
    const forged = validateContract(
      ScaP02SemgrepPhpResultV1Schema,
      { ...result, ...forgedGraph },
      "structurally valid forged provenance"
    );
    expect(() => validateScaP02OperationResultV1("semgrep_php", request, forged)).toThrow(
      /canonical decoded component semantics/u
    );

    // Keep a surviving disposition so omission reaches graph coverage, not schema minItems.
    const coverage = semgrepResult([finding, { ...finding, start: { line: 8 } }]);
    const complete = validateScaP02OperationResultV1(
      "semgrep_php",
      coverage.request,
      coverage.result
    );
    expect(complete.normalized_observations).toHaveLength(2);
    const omitted = complete.normalized_observations[0];
    if (omitted === undefined) throw Error("missing provenance omission operand");
    const incomplete = validateContract(
      ScaP02SemgrepPhpResultV1Schema,
      {
        ...complete,
        normalized_observations: complete.normalized_observations.filter(
          (observation) => observation.observation_id !== omitted.observation_id
        ),
        correlations: complete.correlations.filter(
          (correlation) => correlation.normalized_observation_id !== omitted.observation_id
        ),
      },
      "structurally valid incomplete provenance"
    );
    expect(incomplete.normalized_observations).toHaveLength(1);
    expect(incomplete.correlations.length).toBeGreaterThan(0);
    expect(incomplete.raw_evidence).toEqual(complete.raw_evidence);
    expect(incomplete.raw_records).toEqual(complete.raw_records);
    expect(() =>
      validateScaP02OperationResultV1("semgrep_php", coverage.request, incomplete)
    ).toThrow(
      /every raw record and normalized observation must have exactly one correlation disposition/u
    );
    // An entirely empty graph remains a structural refusal, independently of semantic coverage.
    expect(() =>
      validateScaP02OperationResultV1("semgrep_php", request, {
        ...result,
        normalized_observations: [],
        correlations: [],
      })
    ).toThrow(/failed schema validation: \/correlations: minItems constraint failed/u);
  });

  it("rejects scanner component rule, source, executable-version, and runtime identity drift", () => {
    const { request, result } = semgrepResult([
      {
        check_id: "semgrep-rule",
        path: "src/example.php",
        start: { line: 7 },
        extra: { message: "unsafe flow" },
      },
    ]);
    const encoded = result.raw_evidence[0]?.content_base64;
    if (encoded === undefined) throw new Error("Semgrep fixture evidence is absent");
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Semgrep fixture evidence is not an object");
    }
    const component = parsed;
    for (const [field, value] of [
      ["source_snapshot_sha256", "0".repeat(64)],
      ["rule_config_sha256", "1".repeat(64)],
      ["tool_version", "other-version"],
      ["runtime_identity", "other-runtime"],
      ["runtime_sha256", "2".repeat(64)],
    ] as const) {
      const bundle = buildScaP02RawEvidenceV1({
        analyzer_id: "semgrep-php",
        value: { ...component, [field]: value },
      });
      const provenance = deriveScaP02ProvenanceV1({
        raw_evidence: [bundle.evidence],
        raw_records: bundle.raw_records,
      });
      expect(() =>
        validateScaP02OperationResultV1("semgrep_php", request, {
          ...result,
          raw_evidence: [bundle.evidence],
          raw_records: bundle.raw_records,
          ...provenance,
        })
      ).toThrow(/stale|binding/u);
    }
  });

  it("rejects adapter execution when the host component authority is absent", async () => {
    let reads = 0;
    const adapter = createScaP02OperationAdaptersWithoutAuthorityV1({
      now: () => FIXED_NOW,
    }).get("sca-p02-semgrep-php-adapter-v1");
    if (adapter === undefined) throw new Error("Semgrep PHP adapter is absent");
    await expect(
      adapter.run(
        context({
          kind: "semgrep_php",
          request: semgrepRequest(),
          onRead: () => {
            reads += 1;
          },
          capture: () => undefined,
        })
      )
    ).rejects.toThrow(/component_validation_authority_unavailable/u);
    expect(reads).toBe(0);
  });

  it("blocks a source scanner before reading custody when no isolation runner was injected", async () => {
    let reads = 0;
    let persisted = "";
    const adapter = createScaP02OperationAdaptersV1({ now: () => FIXED_NOW }).get(
      "sca-p02-semgrep-php-adapter-v1"
    );
    if (adapter === undefined) throw new Error("Semgrep PHP adapter is absent");
    await adapter.run(
      context({
        kind: "semgrep_php",
        request: semgrepRequest(),
        onRead: () => {
          reads += 1;
        },
        capture: (content) => {
          persisted = content;
        },
      })
    );
    const parsed: unknown = JSON.parse(persisted);
    const result = validateScaP02OperationResultV1(
      "semgrep_php",
      validateScaP02OperationRequestV1("semgrep_php", semgrepRequest()),
      parsed
    );
    expect(reads).toBe(0);
    expect(result.status).toBe("blocked");
    expect(result.analyzer_results[0]?.blocker_codes).toEqual(["isolation_unavailable"]);
  });

  it("refuses direct host spawn for live-qualified scanner without exact controlled runner", async () => {
    const { live, isolation, evidenceBytes } = liveSemgrepFixture();
    let runs = 0;
    let reads = 0;
    let persisted = "";
    const adapter = createScaP02OperationAdaptersV1({
      isolation: {
        ...isolation,
        run: async ({ execute }) => {
          runs += 1;
          return execute();
        },
      },
    }).get("sca-p02-semgrep-php-adapter-v1");
    if (adapter === undefined) throw Error("missing adapter");
    await adapter.run(
      context({
        kind: "semgrep_php",
        request: live,
        isolationEvidenceBytes: evidenceBytes,
        capture: (bytes) => {
          persisted = bytes;
        },
        onRead: () => {
          reads += 1;
        },
      })
    );
    const result = validateScaP02OperationResultV1("semgrep_php", live, JSON.parse(persisted));
    expect(result.status).toBe("blocked");
    expect(result.analyzer_results[0]?.blocker_codes).toEqual(["controlled_process_unavailable"]);
    expect(runs).toBe(0);
    expect(reads).toBe(1);
    // A structural lookalike with matching strings is not a factory-issued controlled runner.
    const forged = createScaP02OperationAdaptersV1({
      isolation: {
        ...isolation,
        run: async ({ execute }) => {
          runs += 1;
          return execute();
        },
      },
      controlled_process_runners: {
        semgrep_php: {
          qualification: "controlled_p02_scanners_only",
          profile_sha256: live.isolation_profile_sha256,
          deployment_sha256: live.isolation_deployment_sha256,
          run: async () => {
            throw Error("forged_runner_called");
          },
          kind: "semgrep_php",
        },
      },
    }).get("sca-p02-semgrep-php-adapter-v1");
    if (forged === undefined) throw Error("missing adapter");
    await forged.run(
      context({
        kind: "semgrep_php",
        request: live,
        isolationEvidenceBytes: evidenceBytes,
        capture: (bytes) => {
          persisted = bytes;
        },
        onRead: () => {
          reads += 1;
        },
      })
    );
    const refused = validateScaP02OperationResultV1("semgrep_php", live, JSON.parse(persisted));
    expect(refused.analyzer_results[0]?.blocker_codes).toEqual(["controlled_process_unavailable"]);
    expect(runs).toBe(0);
    expect(reads).toBe(2);
    const files = [{ path: "a.php", bytes: 1, sha256: sha256("x") }];
    const staticRunner = createP02HostProcessRunnerV1(
      {
        kind: "semgrep_php",
        source: {
          root: "/not-materialized/source",
          files,
          total_bytes: 1,
          tree_sha256: sha256(canonicalJson(files)),
        },
        rule: { path: "/not-materialized/rule.yaml", sha256: "e".repeat(64) },
        tool_runtime: {
          kind: "sealed",
          tree: {
            root: "/sealed/runtime",
            files: [{ path: "semgrep", bytes: 1, sha256: "d".repeat(64) }],
            total_bytes: 1,
            tree_sha256: sha256(
              canonicalJson([{ path: "semgrep", bytes: 1, sha256: "d".repeat(64) }])
            ),
          },
          mount_root: "/not-executed",
          executable: "semgrep",
          executable_sha256: "d".repeat(64),
          tool_version: "1.168.0",
          same_uid_residual_ack: true,
        },
        runtime: { path: "/usr/bin/node", sha256: "f".repeat(64) },
        closure: [],
        deployment: { path: "/deployment", sha256: live.isolation_deployment_sha256 },
        controls: {
          bwrap: "f".repeat(64),
          systemd_run: "f".repeat(64),
          systemctl: "f".repeat(64),
          scratch_launcher: "f".repeat(64),
          mount: "f".repeat(64),
          setpriv: "f".repeat(64),
        },
        profile_sha256: live.isolation_profile_sha256,
        workspace_parent: "/workspace",
        protected_roots: ["/private-state"],
        limits: {
          scratch_bytes: 1048576,
          memory_bytes: 134217728,
          tasks: 8,
          cpu_percent: 50,
          runtime_ms: 10000,
          output_bytes: 65536,
        },
      },
      "/scratch-static"
    );
    expect(isControlledP02RunnerV1(staticRunner)).toBe(true);
    expect(isControlledP02FactoryRunnerV1(staticRunner)).toBe(false);
    const direct = createScaP02OperationAdaptersV1({
      isolation: {
        ...isolation,
        run: async ({ execute }) => execute(),
      },
      controlled_process_runners: { semgrep_php: staticRunner },
    }).get("sca-p02-semgrep-php-adapter-v1");
    if (direct === undefined) throw Error("missing adapter");
    await direct.run(
      context({
        kind: "semgrep_php",
        request: live,
        isolationEvidenceBytes: evidenceBytes,
        capture: (bytes) => {
          persisted = bytes;
        },
        onRead: () => {
          reads += 1;
        },
      })
    );
    expect(
      validateScaP02OperationResultV1("semgrep_php", live, JSON.parse(persisted))
        .analyzer_results[0]?.blocker_codes
    ).toEqual(["controlled_process_unavailable"]);
    expect(reads).toBe(3);
  });

  it("rejects missing, swapped and aggregate-as-operation live profiles before scanner dispatch", async () => {
    const { live, isolation, evidenceBytes } = liveSemgrepFixture();
    const run = async (
      runtime: ScaP02OperationAdapterOptionsV1["isolation"],
      request: object = live
    ) => {
      let reached = 0;
      const adapter = createScaP02OperationAdaptersV1({ isolation: runtime }).get(
        "sca-p02-semgrep-php-adapter-v1"
      );
      if (adapter === undefined) throw Error("missing adapter");
      await expect(
        adapter.run(
          context({
            kind: "semgrep_php",
            request,
            isolationEvidenceBytes: evidenceBytes,
            capture: () => {
              reached++;
            },
          })
        )
      ).rejects.toThrow();
      expect(reached).toBe(0);
    };
    const absentProfiles = { ...isolation };
    Reflect.deleteProperty(absentProfiles, "operation_profiles");
    await run(absentProfiles);
    await run(undefined);
    await run({
      ...isolation,
      profile_sha256: LIVE_PROFILES.semgrep_php,
      run: async ({ execute }) => execute(),
    });
    const swapped = {
      ...LIVE_PROFILES,
      semgrep_php: LIVE_PROFILES.osv_npm,
      osv_npm: LIVE_PROFILES.semgrep_php,
    };
    await run({
      ...isolation,
      operation_profiles: swapped,
      profile_sha256: scaP02AggregateProfileSha256(swapped),
      run: async ({ execute }) => execute(),
    });
    const aggregateRequest = validateScaP02OperationRequestV1(
      "semgrep_php",
      withScaP02Digest({ ...live, isolation_profile_sha256: LIVE_AGGREGATE }, "request_sha256")
    );
    await run({ ...isolation, run: async ({ execute }) => execute() }, aggregateRequest);
  });

  it("selects distinct npm and Composer OSV profiles before an issued transport can send", async () => {
    const { live: scanner, isolation, evidenceBytes } = liveSemgrepFixture();
    let sends = 0;
    let wrongTransportSends = 0;
    const transport = {
      ip_confinement: "external_worker_enforced" as const,
      async send(request: { readonly url: string; readonly body: string | null }) {
        sends++;
        expect(request.body).not.toBeNull();
        return {
          status_code: 200,
          final_url: request.url,
          redirected: false,
          body: Buffer.from(canonicalJson({ results: [{ vulns: [] }] })),
        };
      },
    };
    const wrongTransport = {
      ip_confinement: "external_worker_enforced" as const,
      async send() {
        wrongTransportSends++;
        throw new Error("cross-ecosystem OSV transport selected");
      },
    };
    osvIssuer.current = transport;
    for (const kind of ["osv_composer", "osv_npm"] as const) {
      const npm = osvRequest();
      const packageValue =
        kind === "osv_npm"
          ? npm.coordinates[0]?.package
          : { ecosystem: "Packagist" as const, name: "vendor/example", version: "1.0.0" };
      if (packageValue === undefined) throw new Error("missing OSV coordinate");
      const queryId = scaDependencyCoordinateIdV2(
        packageValue.ecosystem,
        packageValue.name,
        packageValue.version
      );
      const request = validateScaP02OperationRequestV1(
        kind,
        withScaP02Digest(
          {
            ...npm,
            schema_id:
              kind === "osv_npm"
                ? SCA_P02_OSV_NPM_REQUEST_V1_SCHEMA
                : SCA_P02_OSV_COMPOSER_REQUEST_V1_SCHEMA,
            operation_kind: kind,
            operation_id: SCA_P02_OPERATION_IDS[kind],
            ecosystem: packageValue.ecosystem,
            coordinates: [{ query_id: queryId, package: packageValue }],
            mappings: [
              {
                query_id: queryId,
                occurrence_id: `depocc_${"f".repeat(64)}`,
                package: packageValue,
              },
            ],
            isolation_evidence_ref: scanner.isolation_evidence_ref,
            isolation_runtime_kind: "host_qualified",
            isolation_qualification_scope: "live_qualified",
            isolation_profile_sha256: LIVE_PROFILES[kind],
            isolation_host_attestation_id: scanner.isolation_host_attestation_id,
            isolation_host_attestation_sha256: scanner.isolation_host_attestation_sha256,
            isolation_host_attestation_ref: scanner.isolation_host_attestation_ref,
          },
          "request_sha256"
        )
      );
      if (!("transport_id" in request)) throw new Error("OSV request was not validated");
      let persisted = "";
      const otherKind = kind === "osv_composer" ? "osv_npm" : "osv_composer";
      const adapter = createScaP02OperationAdaptersV1({
        isolation,
        osv_transports: {
          [kind]: { transport_id: request.transport_id, transport },
          [otherKind]: { transport_id: request.transport_id, transport: wrongTransport },
        },
        now: () => FIXED_NOW,
      }).get(`sca-p02-${kind.replaceAll("_", "-")}-adapter-v1`);
      if (adapter === undefined) throw new Error("missing OSV adapter");
      await adapter.run(
        context({
          kind,
          request,
          isolationEvidenceBytes: evidenceBytes,
          capture: (content) => {
            persisted = content;
          },
        })
      );
      const result = validateScaP02OperationResultV1(kind, request, JSON.parse(persisted));
      expect(result.status).toBe("complete");
      expect(sends).toBe(kind === "osv_composer" ? 1 : 2);
      expect(wrongTransportSends).toBe(0);
      const wrong = validateScaP02OperationRequestV1(
        kind,
        withScaP02Digest({ ...request, isolation_profile_sha256: LIVE_AGGREGATE }, "request_sha256")
      );
      await expect(
        adapter.run(
          context({
            kind,
            request: wrong,
            isolationEvidenceBytes: evidenceBytes,
            capture: () => {
              throw new Error("wrong OSV profile persisted");
            },
          })
        )
      ).rejects.toThrow(/live_isolation_profile_binding_invalid/u);
      expect(sends).toBe(kind === "osv_composer" ? 1 : 2);
    }
  });

  it("compares every runtime-isolation identity field exactly before scanner reachability", async () => {
    let reads = 0;
    let isolationRuns = 0;
    let persisted = "";
    const adapter = createScaP02OperationAdaptersV1({
      isolation: {
        isolation_id: "test-isolation",
        runtime_id: "test-runtime",
        implementation_identity_sha256: "1".repeat(64),
        deployment_identity_sha256: "3".repeat(64),
        profile_id: "test-profile",
        profile_sha256: "b".repeat(64),
        qualification_scope: "deterministic_test_only",
        runtime_kind: "simulated_test_runtime",
        simulation_label: "simulated_test_seam",
        run: async ({ execute }) => {
          isolationRuns += 1;
          return execute();
        },
      },
      now: () => FIXED_NOW,
    }).get("sca-p02-semgrep-php-adapter-v1");
    if (adapter === undefined) throw new Error("Semgrep PHP adapter is absent");
    await adapter.run(
      context({
        kind: "semgrep_php",
        request: semgrepRequest(),
        onRead: () => {
          reads += 1;
        },
        capture: (content) => {
          persisted = content;
        },
      })
    );
    const result = validateScaP02OperationResultV1(
      "semgrep_php",
      validateScaP02OperationRequestV1("semgrep_php", semgrepRequest()),
      JSON.parse(persisted)
    );
    expect(result.analyzer_results[0]?.blocker_codes).toEqual(["isolation_unavailable"]);
    expect(isolationRuns).toBe(0);
    expect(reads).toBe(0);
  });

  it("requires prior-process termination proof before rerunning a submitted local scanner", async () => {
    let reads = 0;
    const adapter = createScaP02OperationAdaptersV1({
      isolation: {
        isolation_id: "test-isolation",
        runtime_id: "test-runtime",
        implementation_identity_sha256: "1".repeat(64),
        deployment_identity_sha256: "2".repeat(64),
        profile_id: "test-profile",
        profile_sha256: "b".repeat(64),
        qualification_scope: "deterministic_test_only",
        runtime_kind: "simulated_test_runtime",
        simulation_label: "simulated_test_seam",
        run: async ({ execute }) => execute(),
      },
      now: () => FIXED_NOW,
    }).get("sca-p02-semgrep-php-adapter-v1");
    if (adapter === undefined) throw new Error("Semgrep PHP adapter is absent");
    await expect(
      adapter.run(
        context({
          kind: "semgrep_php",
          request: semgrepRequest(),
          lifecycle: "submitted",
          onRead: () => {
            reads += 1;
          },
          capture: () => {
            throw new Error("unproven local recovery must not persist");
          },
        })
      )
    ).rejects.toThrow(/local_prior_process_termination_unproven/u);
    expect(reads).toBe(0);
  });

  it("adopts exact cached result bytes at fetched and persisting boundaries without rerunning work", async () => {
    let produced = "";
    const producer = createScaP02OperationAdaptersV1({ now: () => FIXED_NOW }).get(
      "sca-p02-semgrep-php-adapter-v1"
    );
    if (producer === undefined) throw new Error("Semgrep PHP adapter is absent");
    await producer.run(
      context({
        kind: "semgrep_php",
        request: semgrepRequest(),
        capture: (content) => {
          produced = content;
        },
      })
    );
    let isolationRuns = 0;
    let reads = 0;
    const adopter = createScaP02OperationAdaptersV1({
      isolation: {
        isolation_id: "test-isolation",
        runtime_id: "test-runtime",
        implementation_identity_sha256: "1".repeat(64),
        deployment_identity_sha256: "2".repeat(64),
        profile_id: "test-profile",
        profile_sha256: "b".repeat(64),
        qualification_scope: "deterministic_test_only",
        runtime_kind: "simulated_test_runtime",
        simulation_label: "simulated_test_seam",
        run: async ({ execute }) => {
          isolationRuns += 1;
          return execute();
        },
      },
      now: () => new Date("2027-01-01T00:00:00.000Z"),
    }).get("sca-p02-semgrep-php-adapter-v1");
    if (adopter === undefined) throw new Error("Semgrep PHP adapter is absent");
    for (const lifecycle of ["fetched", "persisting"] as const) {
      let adopted = "";
      await adopter.run(
        context({
          kind: "semgrep_php",
          request: semgrepRequest(),
          lifecycle,
          cachedBytes: Buffer.from(produced, "utf8"),
          onRead: () => {
            reads += 1;
          },
          capture: (content) => {
            adopted = content;
          },
        })
      );
      expect(adopted).toBe(produced);
    }
    expect(isolationRuns).toBe(0);
    expect(reads).toBe(0);
  });

  it("fails closed at fetched and persisting recovery boundaries when exact cached bytes are absent or corrupt", async () => {
    let reads = 0;
    const adapter = createScaP02OperationAdaptersV1({ now: () => FIXED_NOW }).get(
      "sca-p02-semgrep-php-adapter-v1"
    );
    if (adapter === undefined) throw new Error("Semgrep PHP adapter is absent");
    for (const lifecycle of ["fetched", "persisting"] as const) {
      await expect(
        adapter.run(
          context({
            kind: "semgrep_php",
            request: semgrepRequest(),
            lifecycle,
            onRead: () => {
              reads += 1;
            },
            capture: () => {
              throw new Error("missing-cache recovery must not persist");
            },
          })
        )
      ).rejects.toThrow(/cached_operation_result_missing_after_fetch/u);
    }
    await expect(
      adapter.run(
        context({
          kind: "semgrep_php",
          request: semgrepRequest(),
          lifecycle: "fetched",
          cachedBytes: Buffer.from('{"not":"a valid result"}', "utf8"),
          onRead: () => {
            reads += 1;
          },
          capture: () => {
            throw new Error("corrupt-cache recovery must not persist");
          },
        })
      )
    ).rejects.toThrow();
    expect(reads).toBe(0);
  });

  it("permits a submitted local rerun only with injected prior-process termination proof", async () => {
    let proofs = 0;
    let reads = 0;
    let persisted = "";
    const adapter = createScaP02OperationAdaptersV1({
      isolation: {
        isolation_id: "test-isolation",
        runtime_id: "test-runtime",
        implementation_identity_sha256: "1".repeat(64),
        deployment_identity_sha256: "2".repeat(64),
        profile_id: "test-profile",
        profile_sha256: "b".repeat(64),
        qualification_scope: "deterministic_test_only",
        runtime_kind: "simulated_test_runtime",
        simulation_label: "simulated_test_seam",
        run: async ({ execute }) => execute(),
      },
      local_recovery: {
        prove_prior_process_terminated: (prior) => {
          expect(prior).toEqual({
            operation_kind: "semgrep_php",
            request_sha256: semgrepRequest().request_sha256,
            prior_correlation_id: `p02_${semgrepRequest().request_sha256}`,
          });
          proofs += 1;
          return true;
        },
      },
      now: () => FIXED_NOW,
    }).get("sca-p02-semgrep-php-adapter-v1");
    if (adapter === undefined) throw new Error("Semgrep PHP adapter is absent");
    await adapter.run(
      context({
        kind: "semgrep_php",
        request: semgrepRequest(),
        lifecycle: "submitted",
        onRead: () => {
          reads += 1;
        },
        capture: (content) => {
          persisted = content;
        },
      })
    );
    const result = validateScaP02OperationResultV1(
      "semgrep_php",
      validateScaP02OperationRequestV1("semgrep_php", semgrepRequest()),
      JSON.parse(persisted)
    );
    expect(proofs).toBe(1);
    expect(reads).toBe(1);
    expect(result.status).toBe("blocked");
    expect(result.analyzer_results[0]?.blocker_codes).toEqual(["adapter_execution_failed"]);
  });

  it("records an empty bound OSV request as not_applicable without invoking a forged transport", async () => {
    let sends = 0;
    let persisted = "";
    const adapter = createScaP02OperationAdaptersV1({
      isolation: {
        isolation_id: "test-isolation",
        runtime_id: "test-runtime",
        implementation_identity_sha256: "1".repeat(64),
        deployment_identity_sha256: "2".repeat(64),
        profile_id: "test-profile",
        profile_sha256: "b".repeat(64),
        qualification_scope: "deterministic_test_only",
        runtime_kind: "simulated_test_runtime",
        simulation_label: "simulated_test_seam",
        run: async ({ execute }) => execute(),
      },
      osv_transports: {
        osv_npm: {
          transport_id: "externally-confined-osv",
          transport: {
            ip_confinement: "external_worker_enforced",
            async send() {
              sends++;
              throw Error("must not send");
            },
          },
        },
      },
      now: () => FIXED_NOW,
    }).get("sca-p02-osv-npm-adapter-v1");
    if (!adapter) throw Error("OSV npm adapter absent");
    const empty = withScaP02Digest(
      { ...osvRequest(), coordinates: [], mappings: [] },
      "request_sha256"
    );
    await adapter.run(
      context({
        kind: "osv_npm",
        request: empty,
        capture: (content) => {
          persisted = content;
        },
      })
    );
    const result = validateScaP02OperationResultV1(
      "osv_npm",
      validateScaP02OperationRequestV1("osv_npm", empty),
      JSON.parse(persisted)
    );
    expect(result.analyzer_results[0]?.applicability).toBe("not_applicable");
    expect(sends).toBe(0);
  });

  it("turns isolation denial and forged OSV transport into blocked evidence without live access", async () => {
    for (const mode of ["denied", "malformed"] as const) {
      let sends = 0;
      let persisted = "";
      const adapter = createScaP02OperationAdaptersV1({
        isolation: {
          isolation_id: "test-isolation",
          runtime_id: "test-runtime",
          implementation_identity_sha256: "1".repeat(64),
          deployment_identity_sha256: "2".repeat(64),
          profile_id: "test-profile",
          profile_sha256: "b".repeat(64),
          qualification_scope: "deterministic_test_only",
          runtime_kind: "simulated_test_runtime",
          simulation_label: "simulated_test_seam",
          run: async ({ execute }) => {
            if (mode === "denied") throw new Error("isolation denied");
            return execute();
          },
        },
        osv_transports: {
          osv_npm: {
            transport_id: "externally-confined-osv",
            transport: {
              ip_confinement: "external_worker_enforced",
              async send(request) {
                sends += 1;
                return {
                  status_code: 200,
                  final_url: request.url,
                  redirected: false,
                  body: Buffer.from("{truncated", "utf8"),
                };
              },
            },
          },
        },
        now: () => FIXED_NOW,
      }).get("sca-p02-osv-npm-adapter-v1");
      if (adapter === undefined) throw new Error("OSV npm adapter is absent");
      await adapter.run(
        context({
          kind: "osv_npm",
          request: osvRequest(),
          capture: (content) => {
            persisted = content;
          },
        })
      );
      const parsed: unknown = JSON.parse(persisted);
      const result = validateScaP02OperationResultV1(
        "osv_npm",
        validateScaP02OperationRequestV1("osv_npm", osvRequest()),
        parsed
      );
      expect(result.status).toBe("blocked");
      expect(sends).toBe(0);
    }
  });

  it("quarantines an uncertain resumed OSV submission instead of sending it again", async () => {
    let sends = 0;
    const adapter = createScaP02OperationAdaptersV1({
      isolation: {
        isolation_id: "test-isolation",
        runtime_id: "test-runtime",
        implementation_identity_sha256: "1".repeat(64),
        deployment_identity_sha256: "2".repeat(64),
        profile_id: "test-profile",
        profile_sha256: "b".repeat(64),
        qualification_scope: "deterministic_test_only",
        runtime_kind: "simulated_test_runtime",
        simulation_label: "simulated_test_seam",
        run: async ({ execute }) => execute(),
      },
      osv_transports: {
        osv_npm: {
          transport_id: "externally-confined-osv",
          transport: {
            ip_confinement: "external_worker_enforced",
            async send() {
              sends += 1;
              throw new Error("resumed uncertain submission must not be sent");
            },
          },
        },
      },
      now: () => FIXED_NOW,
    }).get("sca-p02-osv-npm-adapter-v1");
    if (adapter === undefined) throw new Error("OSV npm adapter is absent");
    await expect(
      adapter.run(
        context({
          kind: "osv_npm",
          request: osvRequest(),
          lifecycle: "submitted",
          capture: () => {
            throw new Error("uncertain submission must not persist a result");
          },
        })
      )
    ).rejects.toThrow(/osv_submission_outcome_uncertain/u);
    expect(sends).toBe(0);
  });

  it("rejects a forged OSV transport before send, even if it offers a cancellation handler", async () => {
    const controller = new AbortController();
    let sends = 0;
    let persists = 0;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const adapter = createScaP02OperationAdaptersV1({
      isolation: {
        isolation_id: "test-isolation",
        runtime_id: "test-runtime",
        implementation_identity_sha256: "1".repeat(64),
        deployment_identity_sha256: "2".repeat(64),
        profile_id: "test-profile",
        profile_sha256: "b".repeat(64),
        qualification_scope: "deterministic_test_only",
        runtime_kind: "simulated_test_runtime",
        simulation_label: "simulated_test_seam",
        run: async ({ execute }) => execute(),
      },
      osv_transports: {
        osv_npm: {
          transport_id: "externally-confined-osv",
          transport: {
            ip_confinement: "external_worker_enforced",
            async send(request) {
              sends += 1;
              markStarted?.();
              return new Promise((_, reject) => {
                request.signal.addEventListener(
                  "abort",
                  () => reject(new DOMException("active OSV cancelled", "AbortError")),
                  { once: true }
                );
              });
            },
          },
        },
      },
      now: () => FIXED_NOW,
    }).get("sca-p02-osv-npm-adapter-v1");
    if (adapter === undefined) throw new Error("OSV npm adapter is absent");
    const running = adapter.run(
      context({
        kind: "osv_npm",
        request: osvRequest(),
        signal: controller.signal,
        capture: () => {
          persists += 1;
        },
      })
    );
    const result = await running;
    expect(result.disposition.outcome).toBe("completed");
    expect(sends).toBe(0);
    expect(persists).toBe(1);
    controller.abort();
    void started;
  });

  it("keeps caller cancellation owner-visible instead of persisting ordinary blocked evidence", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled by fixture", "AbortError"));
    let persists = 0;
    const adapter = createScaP02OperationAdaptersV1({
      isolation: {
        isolation_id: "test-isolation",
        runtime_id: "test-runtime",
        implementation_identity_sha256: "1".repeat(64),
        deployment_identity_sha256: "2".repeat(64),
        profile_id: "test-profile",
        profile_sha256: "b".repeat(64),
        qualification_scope: "deterministic_test_only",
        runtime_kind: "simulated_test_runtime",
        simulation_label: "simulated_test_seam",
        run: async ({ signal }) => {
          throw signal.reason;
        },
      },
      osv_transports: {
        osv_npm: {
          transport_id: "externally-confined-osv",
          transport: {
            ip_confinement: "external_worker_enforced",
            async send() {
              throw new Error("transport must remain unreachable");
            },
          },
        },
      },
      now: () => FIXED_NOW,
    }).get("sca-p02-osv-npm-adapter-v1");
    if (adapter === undefined) throw new Error("OSV npm adapter is absent");
    await expect(
      adapter.run(
        context({
          kind: "osv_npm",
          request: osvRequest(),
          signal: controller.signal,
          capture: () => {
            persists += 1;
          },
        })
      )
    ).rejects.toThrow(/cancelled by fixture/u);
    expect(persists).toBe(0);
  });
});
