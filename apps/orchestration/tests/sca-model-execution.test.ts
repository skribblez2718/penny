import { describe, expect, it } from "vitest";

import {
  SCA_CANDIDATE_ANALYSIS_SCHEMA,
  buildScaModelRegistryV1,
  type ScaModelRegistryV1,
} from "../src/sca/agent-models.js";
import { sealScaCandidateAnalysisResultV1 } from "../src/sca/deep-analysis-contracts.js";
import {
  ScaModelExecutionError,
  executeScaModelAnalysisV1,
  type ScaAnalysisModelCallV1,
  type ScaAnalysisModelInvokerV1,
} from "../src/sca/model-execution.js";

const TARGET_ID = `scatarget_${"a".repeat(64)}`;
const SNAPSHOT = "b".repeat(64);
const M1 = "c".repeat(64);
const PLAN = "d".repeat(64);
const CONTEXT = "e".repeat(64);

function registry(): ScaModelRegistryV1 {
  return buildScaModelRegistryV1({
    schema_id: "penny.sca-model-registry.v1",
    schema_version: 1,
    profiles: ["primary_a", "primary_b", "critic"].map((profile, index) => ({
      profile_id: profile,
      provider_id: `provider-${profile}`,
      model_id: `model-${profile}`,
      runtime_identity_sha256: String(index + 1).repeat(64),
      output_schema_id: SCA_CANDIDATE_ANALYSIS_SCHEMA,
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

function invocation(profile: "primary_a" | "primary_b" | "critic") {
  const index = profile === "primary_a" ? 0 : profile === "primary_b" ? 1 : 2;
  return {
    schema_id: "penny.sca-model-analysis-invocation.v1",
    schema_version: 1,
    execution_request: {
      schema_id: "penny.sca-model-execution-request.v1",
      schema_version: 1,
      run_id: "run-model-execution",
      candidate_id: TARGET_ID,
      profile_id: profile,
      observed_provider_id: `provider-${profile}`,
      observed_model_id: `model-${profile}`,
      observed_runtime_identity_sha256: String(index + 1).repeat(64),
      output_schema_id: SCA_CANDIDATE_ANALYSIS_SCHEMA,
      output_schema_version: 1,
      requested_budget: {
        max_input_tokens: 8_000,
        max_output_tokens: 1_500,
        max_tool_calls: 0,
        max_wall_time_ms: 45_000,
      },
    },
    tenant_id: "tenant-a",
    project_id: "project-a",
    source_snapshot_sha256: SNAPSHOT,
    m1_manifest_sha256: M1,
    plan_sha256: PLAN,
    target_id: TARGET_ID,
    context_sha256: CONTEXT,
  };
}

function outputFor(call: ScaAnalysisModelCallV1, profile: "primary_a" | "primary_b" | "critic") {
  return sealScaCandidateAnalysisResultV1({
    schema_id: "penny.sca-candidate-analysis-result.v1",
    schema_version: 1,
    tenant_id: "tenant-a",
    project_id: "project-a",
    run_id: "run-model-execution",
    source_snapshot_sha256: SNAPSHOT,
    m1_manifest_sha256: M1,
    plan_sha256: PLAN,
    target_id: TARGET_ID,
    profile_id: profile,
    model_admission_sha256: call.admission.admission_sha256,
    status: "completed",
    candidate_verdicts: [],
    file_assessments: [],
    failure_code: null,
  });
}

function expectExecutionError(
  promise: Promise<unknown>,
  code: ScaModelExecutionError["code"]
): Promise<void> {
  return expect(promise).rejects.toMatchObject({ name: "ScaModelExecutionError", code });
}

describe("S-05-T2 mocked schema-pinned model invocation", () => {
  it("runs the fixed two-primary-plus-critic suite without provider substitution", async () => {
    const calls: ScaAnalysisModelCallV1[] = [];
    for (const profile of ["primary_a", "primary_b", "critic"] as const) {
      const invoker: ScaAnalysisModelInvokerV1 = {
        async invoke(call) {
          calls.push(call);
          return outputFor(call, profile);
        },
      };
      const output = await executeScaModelAnalysisV1(registry(), invocation(profile), invoker);
      expect(output.profile_id).toBe(profile);
    }
    expect(calls.map((call) => call.admission.profile_id)).toEqual([
      "primary_a",
      "primary_b",
      "critic",
    ]);
    expect(calls.every((call) => call.context_sha256 === CONTEXT)).toBe(true);
  });

  it("rejects malformed output rather than accepting an unvalidated model claim", async () => {
    await expectExecutionError(
      executeScaModelAnalysisV1(registry(), invocation("primary_a"), {
        async invoke() {
          return { status: "completed", candidate_verdicts: [] };
        },
      }),
      "output_invalid"
    );
  });

  it("rejects output binding drift and an invocation failure", async () => {
    await expectExecutionError(
      executeScaModelAnalysisV1(registry(), invocation("primary_a"), {
        async invoke(call) {
          const output = outputFor(call, "primary_a");
          const { result_sha256: _digest, ...unsigned } = output;
          return sealScaCandidateAnalysisResultV1({ ...unsigned, project_id: "other" });
        },
      }),
      "output_binding_mismatch"
    );
    await expectExecutionError(
      executeScaModelAnalysisV1(registry(), invocation("primary_a"), {
        async invoke() {
          throw new Error("fixture model failure");
        },
      }),
      "model_failed"
    );
  });

  it("fails before model work when the observed provider or budget drifts", async () => {
    let invoked = false;
    const invoker: ScaAnalysisModelInvokerV1 = {
      async invoke() {
        invoked = true;
        return {};
      },
    };
    await expect(
      executeScaModelAnalysisV1(
        registry(),
        {
          ...invocation("primary_a"),
          execution_request: {
            ...invocation("primary_a").execution_request,
            observed_provider_id: "silent-fallback-provider",
          },
        },
        invoker
      )
    ).rejects.toMatchObject({ code: "runtime_identity_mismatch" });
    expect(invoked).toBe(false);

    await expect(
      executeScaModelAnalysisV1(
        registry(),
        {
          ...invocation("primary_a"),
          execution_request: {
            ...invocation("primary_a").execution_request,
            requested_budget: {
              ...invocation("primary_a").execution_request.requested_budget,
              max_input_tokens: 10_001,
            },
          },
        },
        invoker
      )
    ).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(invoked).toBe(false);
  });

  it("keeps deterministic output identity across exact mock replay", async () => {
    const invoker: ScaAnalysisModelInvokerV1 = {
      async invoke(call) {
        return outputFor(call, "critic");
      },
    };
    const first = await executeScaModelAnalysisV1(registry(), invocation("critic"), invoker);
    const second = await executeScaModelAnalysisV1(registry(), invocation("critic"), invoker);
    expect(second).toEqual(first);
    expect(first.result_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
