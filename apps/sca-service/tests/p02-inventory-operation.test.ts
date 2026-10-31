import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactRef } from "../../orchestration/dist/contracts.js";
import type {
  HostOperationExecutionContextV1,
  HostOperationPersistedOutputV1,
} from "../../orchestration/dist/host-operations/contracts.js";
import {
  scaP01SourceTreeDigest,
  validateScaP01SourceCustodyCorpusV1,
} from "../../orchestration/dist/sca/p01-contracts.js";
import {
  SCA_P02_CANDIDATE_PRODUCER,
  SCA_P02_CANDIDATE_REQUEST_KIND,
  SCA_P02_INPUT_SLOTS,
  SCA_P02_INVENTORY_REQUEST_V1_SCHEMA,
  SCA_P02_HOST_ATTESTATION_KIND,
  SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
  SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
  SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
  SCA_P02_OPERATION_IDS,
  SCA_P02_REQUEST_V1_SCHEMA,
  SCA_P02_RUNTIME_POLICY_PRODUCER,
  SCA_P02_RUNTIME_POLICY_V1_SCHEMA,
  SCA_P02_SOURCE_CENSUS_IDENTITY_SHA256,
  scaP02AggregateProfileSha256,
  validateScaP02OperationRequestV1,
  validateScaP02OperationResultV1,
  withScaP02Digest,
} from "../../orchestration/dist/sca/p02-contracts.js";
import { SCA_P02_OPERATION_DECLARATIONS } from "../../orchestration/dist/sca/p02-playbook.js";
import * as treeSitter from "../src/adapters/tree-sitter-index.js";
import { inspectInstalledTreeSitterIdentitiesV2 } from "../src/adapters/tree-sitter-index.js";
import { buildScaP02TreeSitterInputV2 } from "../src/p02-component-inputs.js";
import type { P02ControlledInventoryRunnerV1 } from "../src/p02-host-inventory-runner.js";

// A test-only issued capability seam; production matches only the factory WeakMap.
const fakeIssuer = vi.hoisted(() => ({ current: null as object | null }));
vi.mock("../src/p02-host-inventory-runner.js", async (originalImport) => {
  const original = await originalImport<typeof import("../src/p02-host-inventory-runner.js")>();
  return {
    ...original,
    matchesP02ControlledInventoryRunnerV1: (
      ...args: Parameters<typeof original.matchesP02ControlledInventoryRunnerV1>
    ) => args[0] === fakeIssuer.current || original.matchesP02ControlledInventoryRunnerV1(...args),
  };
});
import { createScaP02OperationAdaptersV1 } from "../src/p02-operations.js";
import { p02TestOperationEnvelope } from "./p02-test-context.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p02-inventory-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function artifactRef(input: {
  readonly label: string;
  readonly kind: string;
  readonly schemaId: string;
  readonly content: string;
}): ArtifactRef {
  const contentDigest = sha256(input.content);
  return {
    schema_version: 2,
    artifact_id: `art_${sha256(`${input.label}:${contentDigest}`)}`,
    run_id: "p02-inventory-fixture",
    phase: "fixture",
    branch_id: null,
    kind: input.kind,
    operation_id: input.label,
    version: 1,
    producer: "host:fixture",
    media_type: "application/json",
    content_schema: { schema_id: input.schemaId, schema_version: 1 },
    byte_length: Buffer.byteLength(input.content, "utf8"),
    content_digest: contentDigest,
    store_ref: `artifact://sha256/${contentDigest}`,
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
    run_id: "p02-inventory-fixture",
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

function sourceFixture() {
  const values = new Map<string, string>([
    [
      "package-lock.json",
      canonicalJson({
        name: "fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": { name: "fixture", version: "1.0.0", dependencies: { lodash: "4.17.21" } },
          "node_modules/lodash": { version: "4.17.21" },
        },
      }),
    ],
    [
      "package.json",
      canonicalJson({ name: "fixture", version: "1.0.0", dependencies: { lodash: "4.17.21" } }),
    ],
    ["src/a.php", "<?php function accepted_fixture(): void {}\n"],
    ["src/b.js", "export function js_fixture() { return 1; }\n"],
    ["src/c.ts", "export function ts_fixture(): number { return 2; }\n"],
  ]);
  const files = [...values.entries()].map(([filePath, content]) => ({
    path: filePath,
    byte_count: Buffer.byteLength(content, "utf8"),
    content_sha256: sha256(content),
  }));
  const tree = scaP01SourceTreeDigest(files);
  const manifest = {
    schema_id: "penny.sca-p01-source-file-manifest.v1",
    schema_version: 1,
    snapshot_id: "p02-inventory-snapshot",
    scope: {
      include_paths: ["package-lock.json", "package.json", "src"],
      exclude_paths: [],
    },
    files,
    file_count: files.length,
    byte_count: files.reduce((total, file) => total + file.byte_count, 0),
    tree_sha256: tree,
  };
  const manifestBytes = canonicalJson(manifest);
  const manifestRef = artifactRef({
    label: "source-manifest",
    kind: "sca-p01-source-file-manifest",
    schemaId: manifest.schema_id,
    content: manifestBytes,
  });
  const custody = {
    schema_id: "penny.sca-p01-source-custody-corpus.v1",
    schema_version: 1,
    custody_id: "p02-inventory-custody",
    snapshot_id: manifest.snapshot_id,
    file_manifest_ref: manifestRef,
    files: files.map((file) => {
      const content = values.get(file.path);
      if (content === undefined) throw new Error(`missing fixture content for '${file.path}'`);
      return {
        path: file.path,
        encoding: "base64",
        content_base64: Buffer.from(content, "utf8").toString("base64"),
        byte_count: file.byte_count,
        content_sha256: file.content_sha256,
      };
    }),
    file_count: files.length,
    byte_count: manifest.byte_count,
    tree_sha256: tree,
    sealed: true,
  };
  const custodyBytes = canonicalJson(custody);
  const custodyRef = artifactRef({
    label: "source-custody",
    kind: "sca-p01-source-custody-corpus",
    schemaId: custody.schema_id,
    content: custodyBytes,
  });
  return { manifestBytes, manifestRef, custodyBytes, custodyRef };
}

function operationContext(input: {
  readonly requestBytes: string;
  readonly manifestBytes: string;
  readonly manifestRef: ArtifactRef;
  readonly custodyBytes: string;
  readonly custodyRef: ArtifactRef;
  readonly capture: (content: string) => void;
  readonly lifecycle?: "lease_acquired" | "submitted" | "fetched" | "persisting";
  readonly onBegin?: () => void;
  readonly onAccepted?: () => void;
  readonly onFetched?: () => void;
  readonly cache: { bytes: Uint8Array | null };
  readonly isolationEvidenceBytes?: string;
}): HostOperationExecutionContextV1 {
  const declaration = SCA_P02_OPERATION_DECLARATIONS.inventory;
  const controller = new AbortController();
  const parsed: unknown = JSON.parse(input.requestBytes);
  const request = validateScaP02OperationRequestV1("inventory", parsed);
  const lifecycle = input.lifecycle ?? "lease_acquired";
  const envelope = p02TestOperationEnvelope({
    declaration,
    requestBytes: input.requestBytes,
    requestSha256: request.request_sha256,
    lifecycle,
    createdAt: "2026-09-20T00:00:00.000Z",
  });
  let journal = envelope.journal;
  return {
    directive: envelope.directive,
    get journal() {
      return structuredClone(journal);
    },
    declaration,
    request_bytes: Buffer.from(input.requestBytes, "utf8"),
    signal: controller.signal,
    reportActivity() {},
    readInput(slot) {
      if (
        slot === SCA_P02_INPUT_SLOTS.isolation_evidence &&
        input.isolationEvidenceBytes !== undefined
      ) {
        return {
          ref: request.isolation_evidence_ref,
          bytes: Buffer.from(input.isolationEvidenceBytes),
        };
      }
      if (slot === SCA_P02_INPUT_SLOTS.source_file_manifest) {
        return { ref: input.manifestRef, bytes: Buffer.from(input.manifestBytes, "utf8") };
      }
      if (slot === SCA_P02_INPUT_SLOTS.source_custody) {
        return { ref: input.custodyRef, bytes: Buffer.from(input.custodyBytes, "utf8") };
      }
      throw new Error(`unexpected slot '${slot}'`);
    },
    emitProgress() {},
    beginSubmission() {
      expect(journal.lifecycle).toBe("lease_acquired");
      journal = { ...journal, lifecycle: "submitting" };
      input.onBegin?.();
    },
    recordRemoteAccepted(correlationId) {
      expect(journal.lifecycle).toBe("submitting");
      journal = {
        ...journal,
        lifecycle: "submitted",
        remote_correlation_id: correlationId,
        remote_correlation_sha256: sha256(correlationId),
      };
      input.onAccepted?.();
    },
    async cacheResult(bytes) {
      input.cache.bytes = Buffer.from(bytes);
      return {
        schema_version: 1 as const,
        request_sha256: request.request_sha256,
        content_sha256: sha256(bytes),
        byte_length: bytes.byteLength,
        bytes: Buffer.from(bytes),
      };
    },
    async readCachedResult() {
      const bytes = input.cache.bytes;
      return bytes === null
        ? null
        : {
            schema_version: 1 as const,
            request_sha256: request.request_sha256,
            content_sha256: sha256(bytes),
            byte_length: bytes.byteLength,
            bytes: Buffer.from(bytes),
          };
    },
    recordFetched() {
      expect(["submitted", "fetched"]).toContain(journal.lifecycle);
      journal = { ...journal, lifecycle: "fetched" };
      input.onFetched?.();
    },
    persist(persistence): HostOperationPersistedOutputV1 {
      const content = String(persistence.operation_result.content);
      input.capture(content);
      return {
        operation_result_ref: artifactRef({
          label: "inventory-result",
          kind: declaration.result.artifact_kind,
          schemaId: declaration.result.schema_id,
          content,
        }),
        output_artifacts: [],
      };
    },
    registerRemoteCancellation() {},
  };
}

function inventoryRequest(stagingParent: string) {
  const isolationProfile = "a".repeat(64);
  const sourceSnapshotSha256 = "c".repeat(64);
  const unsigned = {
    schema_id: SCA_P02_INVENTORY_REQUEST_V1_SCHEMA,
    schema_version: 1 as const,
    run_id: "p02-inventory-fixture",
    operation_id: SCA_P02_OPERATION_IDS.inventory,
    operation_kind: "inventory" as const,
    p01_binding_sha256: "b".repeat(64),
    p02_request_ref: boundRef({
      kind: SCA_P02_CANDIDATE_REQUEST_KIND,
      schemaId: SCA_P02_REQUEST_V1_SCHEMA,
      producer: SCA_P02_CANDIDATE_PRODUCER,
      digest: "1".repeat(64),
    }),
    runtime_policy_ref: boundRef({
      kind: "sca-p02-runtime-policy",
      schemaId: SCA_P02_RUNTIME_POLICY_V1_SCHEMA,
      producer: SCA_P02_RUNTIME_POLICY_PRODUCER,
      digest: "2".repeat(64),
    }),
    isolation_evidence_ref: boundRef({
      kind: "sca-p02-isolation-evidence",
      schemaId: SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
      producer: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
      digest: "3".repeat(64),
    }),
    isolation_id: "p02-inventory-test-isolation",
    isolation_runtime_id: "p02-inventory-test-runtime",
    isolation_runtime_kind: "simulated_test_runtime" as const,
    isolation_qualification_scope: "deterministic_test_only" as const,
    isolation_profile_id: "p02-inventory-test-profile",
    isolation_profile_sha256: isolationProfile,
    isolation_implementation_sha256: "d".repeat(64),
    isolation_deployment_sha256: "e".repeat(64),
    isolation_host_attestation_id: null,
    isolation_host_attestation_sha256: null,
    isolation_host_attestation_ref: null,
    source_snapshot_ref: boundRef({
      kind: "source-snapshot",
      schemaId: "penny.sca-campaign-source-snapshot.v2",
      producer: "host:fixture",
      digest: sourceSnapshotSha256,
      schemaVersion: 2,
    }),
    source_snapshot_sha256: sourceSnapshotSha256,
    source_census_identity_sha256: SCA_P02_SOURCE_CENSUS_IDENTITY_SHA256,
    tree_sitter_identity_sha256: sha256(canonicalJson(inspectInstalledTreeSitterIdentitiesV2())),
    staging_parent: stagingParent,
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
  };
  const request = withScaP02Digest(unsigned, "request_sha256");
  return request;
}

afterEach(() => {
  fakeIssuer.current = null;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    try {
      execFileSync("chmod", ["-R", "u+rwx", root]);
    } catch {
      // Best-effort permission restoration for read-only custody quarantine fixtures.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("SCA P02 inventory host operation", () => {
  it("runs custody, census, actual Tree-sitter, and dependency-v2 deterministically", async () => {
    const stagingParent = temporaryRoot();
    const source = sourceFixture();
    const request = inventoryRequest(stagingParent);
    const requestBytes = canonicalJson(request);
    const adapters = createScaP02OperationAdaptersV1({
      component_validation_authority: { validateComponents(): void {} },
      isolation: {
        isolation_id: "p02-inventory-test-isolation",
        runtime_id: "p02-inventory-test-runtime",
        implementation_identity_sha256: "d".repeat(64),
        deployment_identity_sha256: "e".repeat(64),
        profile_id: "p02-inventory-test-profile",
        profile_sha256: request.isolation_profile_sha256,
        qualification_scope: "deterministic_test_only",
        runtime_kind: "simulated_test_runtime",
        simulation_label: "simulated_test_seam",
        run: async ({ execute }) => execute(),
      },
      now: () => new Date("2026-09-20T00:00:00.000Z"),
    });
    const adapter = adapters.get("sca-p02-inventory-adapter-v1");
    if (adapter === undefined) throw new Error("inventory adapter is absent");
    const outputs: string[] = [];
    const cache = { bytes: null as Uint8Array | null };
    for (let index = 0; index < 2; index += 1) {
      await adapter.run(
        operationContext({
          requestBytes,
          ...source,
          cache,
          capture: (content) => outputs.push(content),
        })
      );
    }
    let resumedBegins = 0;
    let resumedAcceptances = 0;
    let resumedFetches = 0;
    for (const lifecycle of ["submitted", "fetched", "persisting"] as const) {
      await adapter.run(
        operationContext({
          requestBytes,
          ...source,
          lifecycle,
          cache,
          onBegin: () => {
            resumedBegins += 1;
          },
          onAccepted: () => {
            resumedAcceptances += 1;
          },
          onFetched: () => {
            resumedFetches += 1;
          },
          capture: (content) => outputs.push(content),
        })
      );
    }
    expect(outputs).toHaveLength(5);
    expect(new Set(outputs).size).toBe(1);
    expect(resumedBegins).toBe(0);
    expect(resumedAcceptances).toBe(0);
    expect(resumedFetches).toBe(2);
    const output = outputs[0];
    if (output === undefined) throw new Error("inventory operation produced no output");
    const parsedOutput: unknown = JSON.parse(output);
    const validatedRequest = validateScaP02OperationRequestV1("inventory", request);
    const result = validateScaP02OperationResultV1("inventory", validatedRequest, parsedOutput);
    expect(result.status).toBe("complete");
    expect(result.analyzer_results).toHaveLength(5);
    expect(result.analyzer_results.filter((entry) => entry.status === "complete")).toHaveLength(5);
    expect(result.raw_evidence.map((entry) => entry.content_schema_id)).toEqual(
      expect.arrayContaining([
        "penny.sca-source-census-result.v1",
        "penny.sca-tree-sitter-index-result.v2",
        "penny.sca-dependency-inventory-result.v2",
        "penny.sca-p02-custody-summary.v1",
      ])
    );
  });
  it("blocks missing and forged live inventory runners, then consumes an issued test result without a host parser fallback", async () => {
    const stagingParent = temporaryRoot();
    const source = sourceFixture();
    const original = inventoryRequest(stagingParent);
    const attestation = boundRef({
      kind: SCA_P02_HOST_ATTESTATION_KIND,
      schemaId: SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
      producer: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
      digest: "9".repeat(64),
    });
    const operationProfiles = {
      inventory: original.isolation_profile_sha256,
      semgrep_php: sha256("semgrep-php-profile"),
      semgrep_js_ts: sha256("semgrep-js-ts-profile"),
      gitleaks: sha256("gitleaks-profile"),
      osv_composer: sha256("osv-composer-profile"),
      osv_npm: sha256("osv-npm-profile"),
    };
    const aggregate = scaP02AggregateProfileSha256(operationProfiles);
    const isolationEvidenceBytes = canonicalJson({
      schema_id: SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
      schema_version: 1,
      producer_id: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
      isolation_id: original.isolation_id,
      runtime_id: original.isolation_runtime_id,
      implementation_identity_sha256: original.isolation_implementation_sha256,
      deployment_identity_sha256: original.isolation_deployment_sha256,
      profile_id: original.isolation_profile_id,
      profile_sha256: aggregate,
      operation_profiles: operationProfiles,
      qualified_at: "2026-09-20T00:00:00.000Z",
      evidence_kind: "host_qualification_attestation",
      runtime_kind: "host_qualified",
      qualification_scope: "live_qualified",
      qualified: true,
      host_attestation_id: "fixture-attestation",
      host_attestation_sha256: attestation.content_digest,
      host_attestation_ref: attestation,
    });
    const evidenceDigest = sha256(isolationEvidenceBytes);
    const live = validateScaP02OperationRequestV1(
      "inventory",
      withScaP02Digest(
        {
          ...original,
          isolation_evidence_ref: {
            ...original.isolation_evidence_ref,
            artifact_id: `art_${evidenceDigest}`,
            content_digest: evidenceDigest,
            byte_length: Buffer.byteLength(isolationEvidenceBytes),
            store_ref: `artifact://sha256/${evidenceDigest}`,
          },
          isolation_runtime_kind: "host_qualified",
          isolation_qualification_scope: "live_qualified",
          isolation_host_attestation_id: "fixture-attestation",
          isolation_host_attestation_sha256: attestation.content_digest,
          isolation_host_attestation_ref: attestation,
        },
        "request_sha256"
      )
    );
    if (live.operation_kind !== "inventory") throw Error("unexpected operation kind");
    const custodyValue: unknown = JSON.parse(source.custodyBytes);
    const custody = validateScaP01SourceCustodyCorpusV1(custodyValue);
    const treeInput = buildScaP02TreeSitterInputV2(live, custody);
    const expected = treeSitter.buildScaTreeSitterIndexV2(treeInput);
    const spy = vi.spyOn(treeSitter, "buildScaTreeSitterIndexV2");
    const isolation = {
      isolation_id: live.isolation_id,
      runtime_id: live.isolation_runtime_id,
      implementation_identity_sha256: live.isolation_implementation_sha256,
      deployment_identity_sha256: live.isolation_deployment_sha256,
      profile_id: live.isolation_profile_id,
      profile_sha256: aggregate,
      operation_profiles: operationProfiles,
      runtime_kind: "host_qualified" as const,
      qualification_scope: "live_qualified" as const,
      host_attestation_id: "fixture-attestation",
      host_attestation_sha256: attestation.content_digest,
      host_attestation_ref: attestation,
      run: async <T>({ execute }: { execute: () => Promise<T> }): Promise<T> => execute(),
    };
    const run = async (
      runner?: P02ControlledInventoryRunnerV1,
      runtime: typeof isolation = isolation
    ) => {
      let content = "";
      const adapter = createScaP02OperationAdaptersV1({
        component_validation_authority: { validateComponents(): void {} },
        isolation: runtime,
        controlled_inventory_runner: runner,
        now: () => new Date("2026-09-20T00:00:00.000Z"),
      }).get("sca-p02-inventory-adapter-v1");
      if (adapter === undefined) throw Error("missing inventory adapter");
      await adapter.run(
        operationContext({
          requestBytes: canonicalJson(live),
          ...source,
          isolationEvidenceBytes,
          cache: { bytes: null },
          capture: (value) => {
            content = value;
          },
        })
      );
      return validateScaP02OperationResultV1("inventory", live, JSON.parse(content));
    };
    expect((await run()).analyzer_results[0]?.blocker_codes).toEqual([
      "controlled_inventory_unavailable",
    ]);
    let calls = 0;
    const fake: P02ControlledInventoryRunnerV1 = {
      qualification: "controlled_p02_inventory_only",
      profile_sha256: live.isolation_profile_sha256,
      deployment_sha256: live.isolation_deployment_sha256,
      async run({ request, source_root, tree_input }, signal) {
        calls++;
        expect(request.request_sha256).toBe(live.request_sha256);
        expect(source_root).toBe(
          path.join(stagingParent, `${live.operation_id}-${live.request_sha256.slice(0, 16)}`)
        );
        expect(tree_input.files.map((f) => f.admitted_language)).toEqual([
          "php",
          "javascript",
          "typescript",
        ]);
        expect(signal?.aborted).toBe(false);
        return expected;
      },
    };
    expect((await run(fake)).analyzer_results[0]?.blocker_codes).toEqual([
      "controlled_inventory_unavailable",
    ]);
    expect(calls).toBe(0);
    fakeIssuer.current = fake; // Test-only issuer; production uses a private WeakMap.
    const positive = await run(fake);
    expect(positive.status).toBe("complete");
    expect(calls).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    const swapped = {
      ...operationProfiles,
      inventory: operationProfiles.osv_npm,
      osv_npm: operationProfiles.inventory,
    };
    await expect(
      run(fake, {
        ...isolation,
        operation_profiles: swapped,
        profile_sha256: scaP02AggregateProfileSha256(swapped),
      })
    ).rejects.toThrow(/live_isolation_profile_binding_invalid/u);
    expect(calls).toBe(1);
    const drifted = { ...expected, files: expected.files.slice(1) };
    const corrupted: P02ControlledInventoryRunnerV1 = { ...fake, run: async () => drifted };
    fakeIssuer.current = corrupted;
    const refused = await run(corrupted);
    expect(refused.status).toBe("blocked");
    expect(refused.analyzer_results[0]?.blocker_codes).toEqual(["adapter_execution_failed"]);
    expect(spy).not.toHaveBeenCalled();
  });
});
