import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../src/canonical-json.js";
import type { ArtifactRef } from "../src/contracts.js";
import {
  SCA_R1_M1_REQUIRED_ANALYZERS,
  ScaStaticNormalizationError,
  buildScaM1ManifestV1,
  validateScaM1ManifestV1,
  type ScaStaticAnalyzerRunInputV1,
  type ScaStaticObservationInputV1,
} from "../src/sca/static-normalization.js";

const RUN_ID = "run-sca-m1-fixture";
const SNAPSHOT = "a".repeat(64);

function artifactRef(
  kind: string,
  operationId: string,
  contentDigest = sha256(operationId)
): ArtifactRef {
  const identity = {
    branch_id: null,
    kind,
    operation_id: operationId,
    phase: "static",
    run_id: RUN_ID,
    version: 1,
  };
  return {
    schema_version: 2,
    artifact_id: `art_${sha256(canonicalJson(identity))}`,
    run_id: RUN_ID,
    phase: "static",
    branch_id: null,
    kind,
    operation_id: operationId,
    version: 1,
    producer: "sca-static-fixture",
    media_type: "application/json",
    byte_length: 64,
    content_digest: contentDigest,
    store_ref: `artifact://sha256/${contentDigest}`,
  };
}

function observation(
  message: string,
  rawRef: ArtifactRef,
  evidenceSha = sha256(message)
): ScaStaticObservationInputV1 {
  return {
    observation_kind: "candidate",
    path: "src/example.php",
    start_line: 10,
    end_line: 12,
    rule_id: "fixture.rule",
    weakness_id: "CWE-79",
    package_coordinate: null,
    advisory_id: null,
    message,
    evidence_sha256: evidenceSha,
    raw_refs: [rawRef],
  };
}

function successfulRuns(): ScaStaticAnalyzerRunInputV1[] {
  return SCA_R1_M1_REQUIRED_ANALYZERS.map((required) => {
    const rawRef = artifactRef("sca-static-raw", `raw-${required.analyzer_id}`);
    return {
      analyzer_id: required.analyzer_id,
      analyzer_kind: required.analyzer_kind,
      status: "succeeded",
      tool_sha256: sha256(`tool:${required.analyzer_id}`),
      configuration_sha256: sha256(`config:${required.analyzer_id}`),
      raw_refs: [rawRef],
      observations:
        required.analyzer_id === "semgrep_php" ||
        required.analyzer_id === "semgrep_javascript_typescript"
          ? [observation("same exact candidate", rawRef)]
          : [],
      failure_code: null,
    };
  });
}

function firstRawRef(run: ScaStaticAnalyzerRunInputV1): ArtifactRef {
  const ref = run.raw_refs[0];
  if (ref === undefined) throw new Error("analyzer fixture has no raw ref");
  return ref;
}

function input(analyzerRuns: readonly ScaStaticAnalyzerRunInputV1[] = successfulRuns()) {
  return {
    schema_id: "penny.sca-static-normalization-input.v1",
    schema_version: 1,
    tenant_id: "tenant-a",
    project_id: "project-a",
    run_id: RUN_ID,
    source_snapshot_sha256: SNAPSHOT,
    source_snapshot_ref: artifactRef("source-snapshot", "source-snapshot", SNAPSHOT),
    model_invocation_count: 0,
    analyzer_runs: analyzerRuns,
  };
}

function expectNormalizationError(
  run: () => unknown,
  code: ScaStaticNormalizationError["code"]
): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaStaticNormalizationError);
    if (error instanceof ScaStaticNormalizationError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected static normalization error '${code}'`);
}

describe("S-04-T4 static normalization and M1 gate", () => {
  it("passes only the complete model-free R1 analyzer set and remains non-releasable", () => {
    const result = buildScaM1ManifestV1(input());
    expect(result).toMatchObject({
      milestone: "M1_STATIC_FOUNDATION",
      status: "passed",
      release_eligible: false,
      model_invocation_count: 0,
      blockers: [],
    });
    expect(result.required_analyzers).toEqual(SCA_R1_M1_REQUIRED_ANALYZERS);
    expect(result.analyzers).toHaveLength(SCA_R1_M1_REQUIRED_ANALYZERS.length);
    expect(validateScaM1ManifestV1(result)).toEqual(result);
  });

  it("deduplicates exact observations while preserving cross-record provenance", () => {
    const result = buildScaM1ManifestV1(input());
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.analyzer_ids).toEqual([
      "semgrep_javascript_typescript",
      "semgrep_php",
    ]);
    expect(result.observations[0]?.raw_refs).toHaveLength(2);
  });

  it("retains contradictory observations as distinct but correlated evidence", () => {
    const runs = successfulRuns();
    const semgrep = runs.find((run) => run.analyzer_id === "semgrep_php");
    if (semgrep === undefined) throw new Error("Semgrep fixture missing");
    const second = observation("candidate contradicted by a guard", firstRawRef(semgrep));
    const changed = runs.map((run) =>
      run.analyzer_id === semgrep.analyzer_id
        ? { ...run, observations: [...run.observations, second] }
        : run
    );
    const result = buildScaM1ManifestV1(input(changed));
    expect(result.observations).toHaveLength(2);
    expect(new Set(result.observations.map((entry) => entry.observation_id)).size).toBe(2);
    expect(new Set(result.observations.map((entry) => entry.correlation_id)).size).toBe(1);
  });

  it("blocks M1 for missing, partial, unavailable, and wrong-kind required analyzers", () => {
    const runs = successfulRuns()
      .filter((run) => run.analyzer_id !== "gitleaks")
      .map((run) =>
        run.analyzer_id === "osv_npm"
          ? {
              ...run,
              status: "unavailable" as const,
              failure_code: "network_disabled",
              observations: [],
            }
          : run
      );
    const syntax = runs.find((run) => run.analyzer_id === "syntax_php");
    if (syntax === undefined) throw new Error("syntax fixture missing");
    const changed = runs.map((run) =>
      run.analyzer_id === syntax.analyzer_id
        ? { ...run, status: "partial" as const, failure_code: "parse_gap" }
        : run
    );
    const result = buildScaM1ManifestV1(input(changed));
    expect(result.status).toBe("blocked");
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ analyzer_id: "gitleaks", reason: "missing" }),
        expect.objectContaining({ analyzer_id: "osv_npm", reason: "unavailable" }),
        expect.objectContaining({ analyzer_id: "syntax_php", reason: "partial" }),
      ])
    );
  });

  it("rejects model use, duplicate analyzer IDs, invalid locations, and artifact drift", () => {
    expectNormalizationError(
      () => buildScaM1ManifestV1({ ...input(), model_invocation_count: 1 }),
      "invalid_input"
    );
    const runs = successfulRuns();
    const firstRun = runs[0];
    if (firstRun === undefined) throw new Error("analyzer fixtures missing");
    expectNormalizationError(
      () => buildScaM1ManifestV1(input([...runs, firstRun])),
      "analyzer_collision"
    );
    const invalidLocation = runs.map((run, index) =>
      index === 0
        ? {
            ...run,
            observations: [
              {
                ...observation("invalid location", firstRawRef(run)),
                path: null,
              },
            ],
          }
        : run
    );
    expectNormalizationError(
      () => buildScaM1ManifestV1(input(invalidLocation)),
      "invalid_observation"
    );
    const validInput = input();
    expectNormalizationError(
      () =>
        buildScaM1ManifestV1({
          ...validInput,
          source_snapshot_ref: {
            ...validInput.source_snapshot_ref,
            content_digest: "f".repeat(64),
          },
        }),
      "artifact_ref_mismatch"
    );
  });

  it("rejects a tampered manifest digest", () => {
    const result = buildScaM1ManifestV1(input());
    expectNormalizationError(
      () => validateScaM1ManifestV1({ ...result, manifest_sha256: "0".repeat(64) }),
      "digest_mismatch"
    );
  });
});
