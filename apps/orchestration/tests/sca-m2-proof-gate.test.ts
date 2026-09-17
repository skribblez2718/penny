import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../src/canonical-json.js";
import type { ArtifactRef } from "../src/contracts.js";
import { buildScaModelRegistryV1 } from "../src/sca/agent-models.js";
import {
  buildScaDeepAnalysisPlanV1,
  sealScaCandidateAnalysisResultV1,
  type ScaCandidateAnalysisResultV1,
  type ScaDeepAnalysisPlanV1,
} from "../src/sca/deep-analysis-contracts.js";
import {
  ScaM2ProofError,
  buildScaM2ManifestV1,
  validateScaM2ManifestV1,
} from "../src/sca/m2-proof-gate.js";
import {
  SCA_R1_M1_REQUIRED_ANALYZERS,
  buildScaM1ManifestV1,
  type ScaM1ManifestV1,
  type ScaStaticAnalyzerRunInputV1,
  type ScaStaticObservationInputV1,
} from "../src/sca/static-normalization.js";

const RUN_ID = "run-sca-m2-fixture";
const SNAPSHOT = "a".repeat(64);

function artifactRef(
  operationId: string,
  kind = "sca-static-raw",
  digest = sha256(operationId)
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
    producer: "sca-m2-fixture",
    media_type: "application/json",
    byte_length: 64,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function observation(
  rawRef: ArtifactRef,
  kind: ScaStaticObservationInputV1["observation_kind"]
): ScaStaticObservationInputV1 {
  return kind === "coverage"
    ? {
        observation_kind: "coverage",
        path: "src/app.ts",
        start_line: null,
        end_line: null,
        rule_id: null,
        weakness_id: null,
        package_coordinate: null,
        advisory_id: null,
        message: "typescript:text:128",
        evidence_sha256: sha256("source"),
        raw_refs: [rawRef],
      }
    : {
        observation_kind: "candidate",
        path: "src/app.ts",
        start_line: 10,
        end_line: 12,
        rule_id: "fixture.injection",
        weakness_id: "CWE-78",
        package_coordinate: null,
        advisory_id: null,
        message: "command injection candidate",
        evidence_sha256: sha256("candidate"),
        raw_refs: [rawRef],
      };
}

function m1Fixture(): ScaM1ManifestV1 {
  const runs: ScaStaticAnalyzerRunInputV1[] = SCA_R1_M1_REQUIRED_ANALYZERS.map((required) => {
    const rawRef = artifactRef(`raw-${required.analyzer_id}`);
    return {
      analyzer_id: required.analyzer_id,
      analyzer_kind: required.analyzer_kind,
      status: "succeeded",
      tool_sha256: sha256(`tool-${required.analyzer_id}`),
      configuration_sha256: sha256(`config-${required.analyzer_id}`),
      raw_refs: [rawRef],
      observations:
        required.analyzer_id === "source_census"
          ? [observation(rawRef, "coverage")]
          : required.analyzer_id === "semgrep_javascript_typescript"
            ? [observation(rawRef, "candidate")]
            : [],
      failure_code: null,
    };
  });
  return buildScaM1ManifestV1({
    schema_id: "penny.sca-static-normalization-input.v1",
    schema_version: 1,
    tenant_id: "tenant-a",
    project_id: "project-a",
    run_id: RUN_ID,
    source_snapshot_sha256: SNAPSHOT,
    source_snapshot_ref: artifactRef("snapshot", "source-snapshot", SNAPSHOT),
    model_invocation_count: 0,
    analyzer_runs: runs,
  });
}

function registryFixture() {
  return buildScaModelRegistryV1({
    schema_id: "penny.sca-model-registry.v1",
    schema_version: 1,
    profiles: ["primary_a", "primary_b", "critic"].map((profile, index) => ({
      profile_id: profile,
      provider_id: `provider-${index}`,
      model_id: `model-${index}`,
      runtime_identity_sha256: String(index + 1).repeat(64),
      output_schema_id: "penny.sca-candidate-analysis-result.v1",
      output_schema_version: 1,
      budget: {
        max_input_tokens: 40_000,
        max_output_tokens: 8_000,
        max_tool_calls: 1,
        max_wall_time_ms: 120_000,
      },
    })),
  });
}

function planFixture(
  m1 = m1Fixture(),
  candidateIds?: string[],
  files?: string[]
): ScaDeepAnalysisPlanV1 {
  const candidates =
    candidateIds ??
    m1.observations
      .filter((entry) => entry.observation_kind === "candidate")
      .map((entry) => entry.observation_id);
  return buildScaDeepAnalysisPlanV1({
    schema_id: "penny.sca-deep-analysis-plan-input.v1",
    schema_version: 1,
    tenant_id: m1.tenant_id,
    project_id: m1.project_id,
    run_id: m1.run_id,
    source_snapshot_sha256: m1.source_snapshot_sha256,
    m1_manifest_sha256: m1.manifest_sha256,
    model_registry_sha256: registryFixture().registry_sha256,
    candidate_ids: candidates,
    required_files: files ?? ["src/app.ts"],
    max_candidates_per_target: 10,
    max_files_per_target: 10,
  });
}

type VerdictChoice = {
  disposition: "confirmed" | "rejected" | "inconclusive";
  severity: "critical" | "high" | "medium" | "low" | "informational" | "unknown";
  reachability: "reachable" | "unreachable" | "unknown";
};

function analysesFixture(
  m1: ScaM1ManifestV1,
  plan: ScaDeepAnalysisPlanV1,
  choices: Record<string, VerdictChoice> = {
    primary_a: { disposition: "confirmed", severity: "high", reachability: "reachable" },
    primary_b: { disposition: "confirmed", severity: "high", reachability: "reachable" },
    critic: { disposition: "confirmed", severity: "medium", reachability: "unknown" },
  }
): ScaCandidateAnalysisResultV1[] {
  return plan.targets.flatMap((target) =>
    target.required_profiles.map((profile_id) => {
      const choice = choices[profile_id];
      if (choice === undefined) throw new Error("verdict choice missing");
      return sealScaCandidateAnalysisResultV1({
        schema_id: "penny.sca-candidate-analysis-result.v1",
        schema_version: 1,
        tenant_id: m1.tenant_id,
        project_id: m1.project_id,
        run_id: m1.run_id,
        source_snapshot_sha256: m1.source_snapshot_sha256,
        m1_manifest_sha256: m1.manifest_sha256,
        plan_sha256: plan.plan_sha256,
        target_id: target.target_id,
        profile_id,
        model_admission_sha256: sha256(`${target.target_id}:${profile_id}`),
        status: "completed",
        candidate_verdicts: target.candidate_ids.map((candidate_id) => ({
          candidate_id,
          ...choice,
          confidence: "high",
          title: "Fixture finding",
          rationale: "Fixture source and sink support the disposition.",
          evidence: [
            {
              path: "src/app.ts",
              start_line: 10,
              end_line: 12,
              evidence_sha256: sha256(`${candidate_id}:evidence`),
              claim: "The source reaches the sink.",
            },
          ],
          gaps: [],
          requested_actions: [],
        })),
        file_assessments: target.required_files.map((path) => ({
          path,
          coverage: "complete",
          candidate_ids_created: [],
          gaps: [],
        })),
        failure_code: null,
      });
    })
  );
}

function calibration(result: "passed" | "failed" = "passed") {
  return ["primary_a", "primary_b", "critic"].map((profile, index) => ({
    profile_id: profile,
    fixture_suite_sha256: sha256(`suite-${index}`),
    evidence_sha256: sha256(`evidence-${index}`),
    result,
    fixture_count: 20,
    false_positive_count: 0,
    false_negative_count: 0,
  }));
}

function proofInput(overrides: Record<string, unknown> = {}) {
  const m1 = m1Fixture();
  const plan = planFixture(m1);
  return {
    schema_id: "penny.sca-m2-proof-input.v1",
    schema_version: 1,
    m1_manifest: m1,
    plan,
    model_registry: registryFixture(),
    analyses: analysesFixture(m1, plan),
    calibration_evidence: calibration(),
    ...overrides,
  };
}

function expectProofError(run: () => unknown, code: ScaM2ProofError["code"]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaM2ProofError);
    if (error instanceof ScaM2ProofError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected SCA M2 proof error '${code}'`);
}

describe("S-05-T4 M2 deep-analysis proof gate", () => {
  it("passes complete three-profile analysis with two-profile quorum and preserved dissent", () => {
    const manifest = buildScaM2ManifestV1(proofInput());
    expect(manifest).toMatchObject({
      milestone: "M2_DEEP_ANALYSIS",
      status: "passed",
      release_eligible: false,
      stronger_execution_authorized: false,
      blockers: [],
    });
    expect(manifest.candidate_consensus[0]).toMatchObject({
      status: "provisional",
      consensus: { disposition: "confirmed", severity: "high", reachability: "reachable" },
      agreeing_profiles: ["primary_a", "primary_b"],
      dissenting_profiles: ["critic"],
    });
    expect(manifest.dissent[0]).toMatchObject({
      profile_id: "critic",
      differs_on: ["severity", "reachability"],
    });
    expect(manifest.file_coverage[0]).toMatchObject({ status: "complete" });
    expect(validateScaM2ManifestV1(manifest)).toEqual(manifest);
  });

  it("blocks unresolved disagreement on disposition, severity, or reachability", () => {
    const input = proofInput();
    const choices = {
      primary_a: { disposition: "confirmed", severity: "high", reachability: "reachable" },
      primary_b: { disposition: "rejected", severity: "unknown", reachability: "unreachable" },
      critic: { disposition: "inconclusive", severity: "medium", reachability: "unknown" },
    } as const;
    const manifest = buildScaM2ManifestV1({
      ...input,
      analyses: analysesFixture(input.m1_manifest, input.plan, choices),
    });
    expect(manifest.status).toBe("blocked");
    expect(manifest.candidate_consensus[0]?.status).toBe("unresolved");
    expect(manifest.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "quorum_unresolved" })])
    );
  });

  it("blocks missing, duplicate, partial, and target-incomplete model results", () => {
    const input = proofInput();
    const analyses = [...input.analyses];
    const first = analyses[0];
    if (first === undefined) throw new Error("analysis fixture missing");
    const { result_sha256: _firstDigest, ...firstUnsigned } = first;
    const partial = sealScaCandidateAnalysisResultV1({
      ...firstUnsigned,
      status: "partial",
      failure_code: "model_turn_budget_exhausted",
    });
    const manifest = buildScaM2ManifestV1({
      ...input,
      analyses: [partial, first, ...analyses.slice(2, analyses.length - 1)],
    });
    expect(manifest.status).toBe("blocked");
    expect(manifest.blockers.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["duplicate_analysis", "analysis_incomplete", "missing_analysis"])
    );
  });

  it("blocks omitted M1 candidates, required files, and failed calibration", () => {
    const m1 = m1Fixture();
    const plan = planFixture(m1, [], []);
    const manifest = buildScaM2ManifestV1({
      schema_id: "penny.sca-m2-proof-input.v1",
      schema_version: 1,
      m1_manifest: m1,
      plan,
      model_registry: registryFixture(),
      analyses: [],
      calibration_evidence: calibration("failed"),
    });
    expect(manifest.status).toBe("blocked");
    expect(manifest.blockers.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "candidate_plan_mismatch",
        "file_plan_mismatch",
        "calibration_failed",
      ])
    );
  });

  it("rejects a tampered manifest digest", () => {
    const manifest = buildScaM2ManifestV1(proofInput());
    expectProofError(
      () => validateScaM2ManifestV1({ ...manifest, manifest_sha256: "0".repeat(64) }),
      "manifest_digest_mismatch"
    );
  });
});
