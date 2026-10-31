import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef } from "../dist/contracts.js";
import { buildScaModelRegistryV1 } from "../dist/sca/agent-models.js";
import {
  buildScaDeepAnalysisPlanV1,
  sealScaCandidateAnalysisResultV1,
  type ScaCandidateAnalysisResultV1,
} from "../dist/sca/deep-analysis-contracts.js";
import {
  ScaFindingDerivationError,
  deriveScaFindingSetV1,
  validateScaFindingSetV1,
} from "../dist/sca/findings.js";
import { buildScaM2ManifestV1 } from "../dist/sca/m2-proof-gate.js";
import {
  SCA_R1_M1_REQUIRED_ANALYZERS,
  buildScaM1ManifestV1,
  type ScaStaticAnalyzerRunInputV1,
} from "../dist/sca/static-normalization.js";

const RUN = "run-findings-fixture";
const SNAPSHOT = "a".repeat(64);

function ref(operation: string, kind = "sca-static-raw", digest = sha256(operation)): ArtifactRef {
  const identity = {
    branch_id: null,
    kind,
    operation_id: operation,
    phase: "static",
    run_id: RUN,
    version: 1,
  };
  return {
    schema_version: 2,
    artifact_id: `art_${sha256(canonicalJson(identity))}`,
    run_id: RUN,
    phase: "static",
    branch_id: null,
    kind,
    operation_id: operation,
    version: 1,
    producer: "finding-fixture",
    media_type: "application/json",
    byte_length: 64,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function fixtureM1() {
  const runs: ScaStaticAnalyzerRunInputV1[] = SCA_R1_M1_REQUIRED_ANALYZERS.map((required) => {
    const raw = ref(required.analyzer_id);
    return {
      analyzer_id: required.analyzer_id,
      analyzer_kind: required.analyzer_kind,
      status: "succeeded",
      tool_sha256: sha256(`tool:${required.analyzer_id}`),
      configuration_sha256: sha256(`config:${required.analyzer_id}`),
      raw_refs: [raw],
      observations:
        required.analyzer_id === "source_census"
          ? [
              {
                observation_kind: "coverage" as const,
                path: "src/app.ts",
                start_line: null,
                end_line: null,
                rule_id: null,
                weakness_id: null,
                package_coordinate: null,
                advisory_id: null,
                message: "typescript:text:256",
                evidence_sha256: sha256("source"),
                raw_refs: [raw],
              },
            ]
          : required.analyzer_id === "semgrep_javascript_typescript"
            ? [
                {
                  observation_kind: "candidate" as const,
                  path: "src/app.ts",
                  start_line: 10,
                  end_line: 12,
                  rule_id: "fixture.command-injection",
                  weakness_id: "CWE-78",
                  package_coordinate: null,
                  advisory_id: null,
                  message: "command injection candidate",
                  evidence_sha256: sha256("candidate"),
                  raw_refs: [raw],
                },
              ]
            : [],
      failure_code: null,
    };
  });
  return buildScaM1ManifestV1({
    schema_id: "penny.sca-static-normalization-input.v1",
    schema_version: 1,
    tenant_id: "tenant-a",
    project_id: "project-a",
    run_id: RUN,
    source_snapshot_sha256: SNAPSHOT,
    source_snapshot_ref: ref("snapshot", "source-snapshot", SNAPSHOT),
    model_invocation_count: 0,
    analyzer_runs: runs,
  });
}

function registry() {
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
        max_input_tokens: 10_000,
        max_output_tokens: 2_000,
        max_tool_calls: 0,
        max_wall_time_ms: 60_000,
      },
    })),
  });
}

type Choice = {
  disposition: "confirmed" | "rejected" | "inconclusive";
  severity: "critical" | "high" | "medium" | "low" | "informational" | "unknown";
  reachability: "reachable" | "unreachable" | "unknown";
};

function fixture(
  choices: Record<string, Choice> = {
    primary_a: { disposition: "confirmed", severity: "high", reachability: "reachable" },
    primary_b: { disposition: "confirmed", severity: "high", reachability: "reachable" },
    critic: { disposition: "confirmed", severity: "medium", reachability: "unknown" },
  }
) {
  const m1 = fixtureM1();
  const modelRegistry = registry();
  const candidateIds = m1.observations
    .filter((entry) => entry.observation_kind === "candidate")
    .map((entry) => entry.observation_id);
  const plan = buildScaDeepAnalysisPlanV1({
    schema_id: "penny.sca-deep-analysis-plan-input.v1",
    schema_version: 1,
    tenant_id: m1.tenant_id,
    project_id: m1.project_id,
    run_id: m1.run_id,
    source_snapshot_sha256: m1.source_snapshot_sha256,
    m1_manifest_sha256: m1.manifest_sha256,
    model_registry_sha256: modelRegistry.registry_sha256,
    candidate_ids: candidateIds,
    required_files: ["src/app.ts"],
    max_candidates_per_target: 10,
    max_files_per_target: 10,
  });
  const analyses: ScaCandidateAnalysisResultV1[] = plan.targets.flatMap((target) => {
    const make = (
      profile_id: "primary_a" | "primary_b" | "critic",
      reviewed_result_sha256s: string[]
    ) => {
      const choice = choices[profile_id];
      if (choice === undefined) throw new Error("choice missing");
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
        reviewed_result_sha256s,
        status: "completed",
        candidate_verdicts: target.candidate_ids.map((candidate_id) => ({
          candidate_id,
          ...choice,
          confidence: profile_id === "critic" ? ("medium" as const) : ("high" as const),
          title: "Untrusted input reaches a command shell",
          rationale: "The route parameter is interpolated into a shell command without validation.",
          remediation:
            "Use a non-shell process API with fixed arguments and strict input validation.",
          evidence: [
            {
              path: "src/app.ts",
              start_line: 10,
              end_line: 12,
              evidence_sha256: sha256("source-lines-10-12"),
              claim: "The route value is interpolated into the command string.",
            },
          ],
          gaps: [],
          requested_actions: [],
        })),
        file_assessments: target.required_files.map((path) => ({
          path,
          coverage: "complete",
          discovered_candidates: [],
          gaps: [],
        })),
        failure_code: null,
      });
    };
    const a = make("primary_a", []);
    const b = make("primary_b", []);
    return [a, b, make("critic", [a.result_sha256, b.result_sha256])];
  });
  const m2 = buildScaM2ManifestV1({
    schema_id: "penny.sca-m2-proof-input.v1",
    schema_version: 1,
    m1_manifest: m1,
    plan,
    model_registry: modelRegistry,
    analyses,
    calibration_evidence: ["primary_a", "primary_b", "critic"].map((profile, index) => ({
      profile_id: profile,
      fixture_suite_sha256: sha256(`suite:${index}`),
      evidence_sha256: sha256(`calibration:${index}`),
      result: "passed",
      fixture_count: 12,
      false_positive_count: 0,
      false_negative_count: 0,
    })),
  });
  return { m1, m2, analyses };
}

function expectFindingError(run: () => unknown, code: ScaFindingDerivationError["code"]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaFindingDerivationError);
    if (error instanceof ScaFindingDerivationError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected SCA finding error '${code}'`);
}

describe("S-06-T3 canonical findings, graph, and control coverage", () => {
  it("derives one stable evidence-linked finding from a confirmed quorum", () => {
    const source = fixture();
    const findingSet = deriveScaFindingSetV1({
      schema_id: "penny.sca-finding-derivation-input.v1",
      schema_version: 1,
      m1_manifest: source.m1,
      m2_manifest: source.m2,
      analyses: source.analyses,
    });
    expect(findingSet.status).toBe("derived");
    expect(findingSet.findings).toHaveLength(1);
    expect(findingSet.findings[0]).toMatchObject({
      weakness_id: "CWE-78",
      severity: "high",
      reachability: "reachable",
      confidence: "high",
      dissenting_profiles: ["critic"],
    });
    expect(findingSet.findings[0]?.evidence[0]?.supporting_profiles).toEqual([
      "primary_a",
      "primary_b",
    ]);
    expect(findingSet.graph_edges.map((edge) => edge.relation)).toEqual(
      expect.arrayContaining(["derived_from", "located_in", "classified_as"])
    );
    expect(findingSet.control_coverage.every((control) => control.status === "complete")).toBe(
      true
    );
    expect(validateScaFindingSetV1(findingSet)).toEqual(findingSet);
    expect(
      deriveScaFindingSetV1({
        schema_id: "penny.sca-finding-derivation-input.v1",
        schema_version: 1,
        m1_manifest: source.m1,
        m2_manifest: source.m2,
        analyses: source.analyses,
      })
    ).toEqual(findingSet);
  });

  it("keeps rejected candidates out of findings and inconclusive candidates explicit", () => {
    const rejected = fixture({
      primary_a: { disposition: "rejected", severity: "unknown", reachability: "unreachable" },
      primary_b: { disposition: "rejected", severity: "unknown", reachability: "unreachable" },
      critic: { disposition: "confirmed", severity: "low", reachability: "unknown" },
    });
    const rejectedSet = deriveScaFindingSetV1({
      schema_id: "penny.sca-finding-derivation-input.v1",
      schema_version: 1,
      m1_manifest: rejected.m1,
      m2_manifest: rejected.m2,
      analyses: rejected.analyses,
    });
    expect(rejectedSet.findings).toEqual([]);
    expect(rejectedSet.candidate_dispositions[0]?.disposition).toBe("rejected");

    const inconclusive = fixture({
      primary_a: { disposition: "inconclusive", severity: "unknown", reachability: "unknown" },
      primary_b: { disposition: "inconclusive", severity: "unknown", reachability: "unknown" },
      critic: { disposition: "inconclusive", severity: "unknown", reachability: "unknown" },
    });
    const inconclusiveSet = deriveScaFindingSetV1({
      schema_id: "penny.sca-finding-derivation-input.v1",
      schema_version: 1,
      m1_manifest: inconclusive.m1,
      m2_manifest: inconclusive.m2,
      analyses: inconclusive.analyses,
    });
    expect(inconclusiveSet.findings).toEqual([]);
    expect(inconclusiveSet.unresolved_candidate_ids).toHaveLength(1);
  });

  it("blocks derivation when M2 is unresolved", () => {
    const source = fixture({
      primary_a: { disposition: "confirmed", severity: "high", reachability: "reachable" },
      primary_b: { disposition: "rejected", severity: "unknown", reachability: "unreachable" },
      critic: { disposition: "inconclusive", severity: "medium", reachability: "unknown" },
    });
    expect(source.m2.status).toBe("blocked");
    expectFindingError(
      () =>
        deriveScaFindingSetV1({
          schema_id: "penny.sca-finding-derivation-input.v1",
          schema_version: 1,
          m1_manifest: source.m1,
          m2_manifest: source.m2,
          analyses: source.analyses,
        }),
      "m2_not_passed"
    );
  });

  it("detects individual finding and aggregate digest tamper", () => {
    const source = fixture();
    const findingSet = deriveScaFindingSetV1({
      schema_id: "penny.sca-finding-derivation-input.v1",
      schema_version: 1,
      m1_manifest: source.m1,
      m2_manifest: source.m2,
      analyses: source.analyses,
    });
    const finding = findingSet.findings[0];
    if (finding === undefined) throw new Error("finding fixture missing");
    expectFindingError(
      () =>
        validateScaFindingSetV1({
          ...findingSet,
          findings: [{ ...finding, finding_sha256: "0".repeat(64) }],
        }),
      "finding_digest_mismatch"
    );
    expectFindingError(
      () => validateScaFindingSetV1({ ...findingSet, finding_set_sha256: "0".repeat(64) }),
      "finding_set_digest_mismatch"
    );
  });
});
