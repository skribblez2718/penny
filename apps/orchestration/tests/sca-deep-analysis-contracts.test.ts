import { describe, expect, it } from "vitest";

import {
  ScaDeepAnalysisContractError,
  buildScaDeepAnalysisPlanV1,
  sealScaCandidateAnalysisResultV1,
  validateScaCandidateAnalysisResultV1,
  validateScaDeepAnalysisPlanV1,
} from "../dist/sca/deep-analysis-contracts.js";

const DIGEST = "a".repeat(64);

function planInput() {
  return {
    schema_id: "penny.sca-deep-analysis-plan-input.v1",
    schema_version: 1,
    tenant_id: "tenant-a",
    project_id: "project-a",
    run_id: "run-sca-deep",
    source_snapshot_sha256: DIGEST,
    m1_manifest_sha256: "b".repeat(64),
    model_registry_sha256: "c".repeat(64),
    candidate_ids: ["candidate-c", "candidate-a", "candidate-b"],
    required_files: ["src/z.ts", "src/a.php", "src/m.js"],
    max_candidates_per_target: 2,
    max_files_per_target: 2,
  };
}

function resultInput() {
  const plan = buildScaDeepAnalysisPlanV1(planInput());
  const target = plan.targets[0];
  if (target === undefined) throw new Error("target fixture missing");
  return {
    schema_id: "penny.sca-candidate-analysis-result.v1" as const,
    schema_version: 1 as const,
    tenant_id: plan.tenant_id,
    project_id: plan.project_id,
    run_id: plan.run_id,
    source_snapshot_sha256: plan.source_snapshot_sha256,
    m1_manifest_sha256: plan.m1_manifest_sha256,
    plan_sha256: plan.plan_sha256,
    target_id: target.target_id,
    profile_id: "primary_a" as const,
    model_admission_sha256: "d".repeat(64),
    reviewed_result_sha256s: [],
    status: "completed" as const,
    candidate_verdicts: target.candidate_ids.map((candidate_id) => ({
      candidate_id,
      disposition: "confirmed" as const,
      severity: "high" as const,
      reachability: "reachable" as const,
      confidence: "high" as const,
      title: "Validated injection path",
      rationale: "The source and sink are connected without a neutralizing control.",
      remediation: "Replace dynamic execution with an allowlisted operation dispatcher.",
      evidence: [
        {
          path: "src/example.ts",
          start_line: 10,
          end_line: 14,
          evidence_sha256: "e".repeat(64),
          claim: "Untrusted input reaches the execution sink.",
        },
      ],
      gaps: [],
      requested_actions: [],
    })),
    file_assessments: [],
    failure_code: null,
  };
}

function expectContractError(run: () => unknown, code: ScaDeepAnalysisContractError["code"]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaDeepAnalysisContractError);
    if (error instanceof ScaDeepAnalysisContractError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected SCA deep-analysis contract error '${code}'`);
}

describe("S-05-T1 deep-analysis contracts and deterministic prepass", () => {
  it("assigns every candidate and required source file exactly once in bounded targets", () => {
    const plan = buildScaDeepAnalysisPlanV1(planInput());
    expect(plan.candidate_ids).toEqual(["candidate-a", "candidate-b", "candidate-c"]);
    expect(plan.required_files).toEqual(["src/a.php", "src/m.js", "src/z.ts"]);
    expect(plan.targets).toHaveLength(4);
    expect(plan.targets.flatMap((target) => target.candidate_ids).sort()).toEqual(
      plan.candidate_ids
    );
    expect(plan.targets.flatMap((target) => target.required_files).sort()).toEqual(
      plan.required_files
    );
    expect(plan.targets.every((target) => target.required_profiles.length === 3)).toBe(true);
    expect(validateScaDeepAnalysisPlanV1(plan)).toEqual(plan);
    expect(buildScaDeepAnalysisPlanV1(planInput())).toEqual(plan);
  });

  it("rejects duplicate candidates, colliding files, unsafe paths, and plan tamper", () => {
    expectContractError(
      () =>
        buildScaDeepAnalysisPlanV1({
          ...planInput(),
          candidate_ids: ["candidate-a", "candidate-a"],
        }),
      "candidate_collision"
    );
    expectContractError(
      () =>
        buildScaDeepAnalysisPlanV1({
          ...planInput(),
          required_files: ["src/a.php", "src/a.php"],
        }),
      "file_collision"
    );
    expectContractError(
      () => buildScaDeepAnalysisPlanV1({ ...planInput(), required_files: ["../secret"] }),
      "unsafe_path"
    );
    const plan = buildScaDeepAnalysisPlanV1(planInput());
    expectContractError(
      () => validateScaDeepAnalysisPlanV1({ ...plan, plan_sha256: "0".repeat(64) }),
      "plan_digest_mismatch"
    );
  });

  it("seals schema-pinned candidate results with evidence and stronger-action requests", () => {
    const input = resultInput();
    const first = input.candidate_verdicts[0];
    if (first === undefined) throw new Error("verdict fixture missing");
    const result = sealScaCandidateAnalysisResultV1({
      ...input,
      candidate_verdicts: [
        {
          ...first,
          requested_actions: [
            {
              action_type: "harness" as const,
              justification: "Static evidence cannot distinguish the sanitizer behavior.",
              expected_discriminator: "Observe whether the tainted value reaches the sink.",
              required_capability: "sandboxed-node-harness-v1",
            },
          ],
        },
        ...input.candidate_verdicts.slice(1),
      ],
    });
    expect(result.status).toBe("completed");
    expect(result.candidate_verdicts[0]?.requested_actions[0]?.action_type).toBe("harness");
    expect(validateScaCandidateAnalysisResultV1(result)).toEqual(result);
  });

  it("preserves partial model failures as typed target results", () => {
    const input = resultInput();
    const result = sealScaCandidateAnalysisResultV1({
      ...input,
      status: "partial",
      candidate_verdicts: input.candidate_verdicts.slice(0, 1),
      failure_code: "model_turn_budget_exhausted",
    });
    expect(result).toMatchObject({
      status: "partial",
      failure_code: "model_turn_budget_exhausted",
    });
  });

  it("rejects inconsistent result status, duplicate verdicts, inverted evidence, and digest drift", () => {
    const input = resultInput();
    expectContractError(
      () => sealScaCandidateAnalysisResultV1({ ...input, failure_code: "unexpected" }),
      "invalid_result"
    );
    const first = input.candidate_verdicts[0];
    if (first === undefined) throw new Error("verdict fixture missing");
    expectContractError(
      () =>
        sealScaCandidateAnalysisResultV1({
          ...input,
          candidate_verdicts: [first, first],
        }),
      "candidate_collision"
    );
    const firstEvidence = first.evidence[0];
    if (firstEvidence === undefined) throw new Error("evidence fixture missing");
    expectContractError(
      () =>
        sealScaCandidateAnalysisResultV1({
          ...input,
          candidate_verdicts: [
            { ...first, evidence: [{ ...firstEvidence, start_line: 20, end_line: 10 }] },
          ],
        }),
      "invalid_result"
    );
    const sealed = sealScaCandidateAnalysisResultV1(input);
    expectContractError(
      () => validateScaCandidateAnalysisResultV1({ ...sealed, result_sha256: "0".repeat(64) }),
      "result_digest_mismatch"
    );
  });
});
