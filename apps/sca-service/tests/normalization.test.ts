import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactRef } from "../../orchestration/dist/contracts.js";
import { buildScaDependencyInventoryV1 } from "../src/adapters/dependency-inventory.js";
import { buildScaSourceCensusV1 } from "../src/adapters/source-census.js";
import { buildScaSyntaxInventoryV1 } from "../src/adapters/syntax-inventory.js";
import {
  normalizeScaDependencyRunV1,
  normalizeScaGitleaksRunV1,
  normalizeScaOsvRunV1,
  normalizeScaSemgrepRunV1,
  normalizeScaSourceCensusRunV1,
  normalizeScaSyntaxInventoryRunV1,
} from "../src/normalization.js";

const RUN_ID = "run-sca-normalization";
const SNAPSHOT = "a".repeat(64);
const TOOL = "b".repeat(64);
const CONFIG = "c".repeat(64);

function artifactRef(operationId: string): ArtifactRef {
  const identity = {
    branch_id: null,
    kind: "sca-static-raw",
    operation_id: operationId,
    phase: "static",
    run_id: RUN_ID,
    version: 1,
  };
  const contentDigest = sha256(`content:${operationId}`);
  return {
    schema_version: 2,
    artifact_id: `art_${sha256(canonicalJson(identity))}`,
    run_id: RUN_ID,
    phase: "static",
    branch_id: null,
    kind: "sca-static-raw",
    operation_id: operationId,
    version: 1,
    producer: "sca-service-fixture",
    media_type: "application/json",
    byte_length: 64,
    content_digest: contentDigest,
    store_ref: `artifact://sha256/${contentDigest}`,
  };
}

function binding(analyzer_id: string) {
  return { analyzer_id, raw_ref: artifactRef(analyzer_id), implementation_sha256: TOOL };
}

describe("S-04-T4 service normalization", () => {
  it("normalizes Semgrep locations, rule, CWE, message, and exact raw provenance", () => {
    const raw = JSON.stringify({
      results: [
        {
          check_id: "fixture.xss",
          path: "src/example.php",
          start: { line: 4, col: 1 },
          end: { line: 6, col: 2 },
          extra: { message: "unescaped output", metadata: { cwe: ["CWE-79"] } },
        },
      ],
      errors: [],
    });
    const run = normalizeScaSemgrepRunV1(
      {
        schema_id: "penny.sca-semgrep-result.v1",
        schema_version: 1,
        source_snapshot_sha256: SNAPSHOT,
        rule_config_sha256: CONFIG,
        status: "findings",
        tool_version: "fixture/1",
        runtime_identity: "fixture-runtime",
        runtime_sha256: TOOL,
        invocation_sha256: sha256("invocation"),
        exit_code: 1,
        finding_count: 1,
        engine_error_count: 0,
        raw_stdout: raw,
        raw_stderr: "",
        raw_stdout_sha256: sha256(raw),
        raw_stderr_sha256: sha256(""),
        truncated: false,
        error_code: "none",
      },
      binding("semgrep_php")
    );
    expect(run).toMatchObject({
      analyzer_id: "semgrep_php",
      analyzer_kind: "semgrep",
      status: "succeeded",
      failure_code: null,
    });
    expect(run.observations).toEqual([
      expect.objectContaining({
        observation_kind: "candidate",
        path: "src/example.php",
        start_line: 4,
        end_line: 6,
        rule_id: "fixture.xss",
        weakness_id: "CWE-79",
        message: "unescaped output",
      }),
    ]);
  });

  it("normalizes redacted Gitleaks candidates without discarding location provenance", () => {
    const raw = JSON.stringify([
      {
        RuleID: "generic-api-key",
        Description: "Generic API key",
        File: "src/config.ts",
        StartLine: 8,
        EndLine: 8,
        Secret: "REDACTED",
        Fingerprint: "fixture",
      },
    ]);
    const run = normalizeScaGitleaksRunV1(
      {
        schema_id: "penny.sca-gitleaks-result.v1",
        schema_version: 1,
        source_snapshot_sha256: SNAPSHOT,
        configuration_sha256: CONFIG,
        status: "findings",
        tool_version: "fixture/1",
        runtime_identity: "fixture-runtime",
        runtime_sha256: TOOL,
        invocation_sha256: sha256("gitleaks-invocation"),
        exit_code: 1,
        finding_count: 1,
        raw_stdout: raw,
        raw_stderr: "",
        raw_stdout_sha256: sha256(raw),
        raw_stderr_sha256: sha256(""),
        truncated: false,
        error_code: "none",
      },
      binding("gitleaks")
    );
    expect(run).toMatchObject({
      analyzer_id: "gitleaks",
      analyzer_kind: "secret_scanner",
      status: "succeeded",
      failure_code: null,
    });
    expect(run.observations[0]).toMatchObject({
      observation_kind: "secret_candidate",
      path: "src/config.ts",
      start_line: 8,
      end_line: 8,
      rule_id: "generic-api-key",
    });
  });

  it("normalizes deterministic source and dependency coverage", () => {
    const census = buildScaSourceCensusV1({
      schema_id: "penny.sca-source-census-input.v1",
      schema_version: 1,
      source_snapshot_sha256: SNAPSHOT,
      tool: { name: "penny-source-census", version: "1", implementation_sha256: TOOL },
      files: [
        {
          path: "src/app.ts",
          byte_length: 10,
          sha256: CONFIG,
          content_kind: "text",
          generated: false,
        },
      ],
      limits: { max_files: 2, max_total_bytes: 100 },
    });
    const censusRun = normalizeScaSourceCensusRunV1(census, binding("source_census"));
    expect(censusRun.observations[0]).toMatchObject({
      observation_kind: "coverage",
      path: "src/app.ts",
      evidence_sha256: CONFIG,
    });

    const content = JSON.stringify({
      lockfileVersion: 3,
      packages: { "node_modules/alpha": { version: "1.0.0" } },
    });
    const dependencies = buildScaDependencyInventoryV1({
      schema_id: "penny.sca-dependency-inventory-input.v1",
      schema_version: 1,
      source_snapshot_sha256: SNAPSHOT,
      manifests: [{ path: "package-lock.json", sha256: sha256(content), content }],
    });
    const dependencyRun = normalizeScaDependencyRunV1(dependencies, binding("dependency_npm"));
    expect(dependencyRun.observations[0]).toMatchObject({
      observation_kind: "dependency",
      path: "package-lock.json",
      package_coordinate: "npm:alpha@1.0.0",
    });
  });

  it("normalizes OSV advisories and preserves a complete no-match as success", () => {
    const resultBase = {
      schema_id: "penny.sca-osv-result.v1",
      schema_version: 1,
      source_snapshot_sha256: SNAPSHOT,
      dependency_inventory_sha256: CONFIG,
      status: "succeeded",
      queried_at: "2026-09-15T00:00:00.000Z",
      origin: "https://api.osv.dev",
      redirects_followed: 0,
      pagination_complete: true,
      coordinates_queried: 1,
      responses: [],
      error_code: "none",
    };
    const noMatch = normalizeScaOsvRunV1(
      {
        ...resultBase,
        advisory_count: 0,
        advisories: [],
        result_sha256: sha256("no-match"),
      },
      binding("osv_npm")
    );
    expect(noMatch).toMatchObject({ status: "succeeded", observations: [], failure_code: null });

    const advisory = normalizeScaOsvRunV1(
      {
        ...resultBase,
        advisory_count: 1,
        advisories: [
          {
            id: "OSV-2026-1",
            modified: "2026-09-01T00:00:00Z",
            published: null,
            aliases: [],
            affected: [{ ecosystem: "npm", name: "alpha", version: "1.0.0" }],
            raw_sha256: TOOL,
          },
        ],
        result_sha256: sha256("match"),
      },
      binding("osv_npm")
    );
    expect(advisory.observations[0]).toMatchObject({
      observation_kind: "advisory",
      advisory_id: "OSV-2026-1",
      package_coordinate: "npm:alpha@1.0.0",
    });
  });

  it("keeps syntax-tool unavailability as a blocking analyzer result", () => {
    const unavailable = buildScaSyntaxInventoryV1({
      schema_id: "penny.sca-syntax-inventory-input.v1",
      schema_version: 1,
      source_snapshot_sha256: SNAPSHOT,
      tool: {
        name: "penny-tree-sitter-indexer",
        version: null,
        implementation_sha256: null,
        grammar_bundle_sha256: null,
        state: "unavailable",
        unavailable_reason: "missing_runtime",
      },
      expected_files: 1,
      files: [],
    });
    const run = normalizeScaSyntaxInventoryRunV1(unavailable, binding("syntax_php"));
    expect(run).toMatchObject({
      status: "unavailable",
      failure_code: "missing_runtime",
      analyzer_kind: "syntax_inventory",
    });
    expect(run.observations[0]?.observation_kind).toBe("tool_failure");
  });
});
