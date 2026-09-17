import { describe, expect, it } from "vitest";

import {
  SCA_CANDIDATE_ANALYSIS_SCHEMA,
  ScaAgentModelError,
  admitScaModelExecutionV1,
  buildScaModelRegistryV1,
  validateScaModelRegistryV1,
} from "../src/sca/agent-models.js";

const RUNTIME = "a".repeat(64);

function registryInput() {
  return {
    schema_id: "penny.sca-model-registry.v1",
    schema_version: 1,
    profiles: [
      {
        profile_id: "critic",
        provider_id: "provider-c",
        model_id: "model-c",
        runtime_identity_sha256: RUNTIME,
        output_schema_id: SCA_CANDIDATE_ANALYSIS_SCHEMA,
        output_schema_version: 1,
        budget: {
          max_input_tokens: 40_000,
          max_output_tokens: 8_000,
          max_tool_calls: 0,
          max_wall_time_ms: 120_000,
        },
      },
      {
        profile_id: "primary_b",
        provider_id: "provider-b",
        model_id: "model-b",
        runtime_identity_sha256: "b".repeat(64),
        output_schema_id: SCA_CANDIDATE_ANALYSIS_SCHEMA,
        output_schema_version: 1,
        budget: {
          max_input_tokens: 80_000,
          max_output_tokens: 12_000,
          max_tool_calls: 2,
          max_wall_time_ms: 180_000,
        },
      },
      {
        profile_id: "primary_a",
        provider_id: "provider-a",
        model_id: "model-a",
        runtime_identity_sha256: "c".repeat(64),
        output_schema_id: SCA_CANDIDATE_ANALYSIS_SCHEMA,
        output_schema_version: 1,
        budget: {
          max_input_tokens: 80_000,
          max_output_tokens: 12_000,
          max_tool_calls: 2,
          max_wall_time_ms: 180_000,
        },
      },
    ],
  };
}

function executionRequest() {
  return {
    schema_id: "penny.sca-model-execution-request.v1",
    schema_version: 1,
    run_id: "run-sca-models",
    candidate_id: "candidate-a",
    profile_id: "primary_a",
    observed_provider_id: "provider-a",
    observed_model_id: "model-a",
    observed_runtime_identity_sha256: "c".repeat(64),
    output_schema_id: SCA_CANDIDATE_ANALYSIS_SCHEMA,
    output_schema_version: 1,
    requested_budget: {
      max_input_tokens: 60_000,
      max_output_tokens: 10_000,
      max_tool_calls: 1,
      max_wall_time_ms: 150_000,
    },
  };
}

function expectModelError(run: () => unknown, code: ScaAgentModelError["code"]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaAgentModelError);
    if (error instanceof ScaAgentModelError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected SCA model error '${code}'`);
}

describe("S-05-T1-B pinned model profiles and budgets", () => {
  it("builds exactly two primary profiles and one critic with a stable digest", () => {
    const registry = buildScaModelRegistryV1(registryInput());
    expect(registry.profiles.map((profile) => profile.profile_id)).toEqual([
      "critic",
      "primary_a",
      "primary_b",
    ]);
    expect(validateScaModelRegistryV1(registry)).toEqual(registry);
    expect(buildScaModelRegistryV1(registryInput())).toEqual(registry);
  });

  it("admits only the exact pinned runtime, schema, and bounded budget", () => {
    const registry = buildScaModelRegistryV1(registryInput());
    const admission = admitScaModelExecutionV1(registry, executionRequest());
    expect(admission).toMatchObject({
      profile_id: "primary_a",
      provider_id: "provider-a",
      model_id: "model-a",
      registry_sha256: registry.registry_sha256,
      admitted_budget: executionRequest().requested_budget,
    });
  });

  it("rejects missing, duplicate, extra, and fallback-shaped profiles", () => {
    const input = registryInput();
    expectModelError(
      () => buildScaModelRegistryV1({ ...input, profiles: input.profiles.slice(0, 2) }),
      "invalid_registry"
    );
    expectModelError(
      () =>
        buildScaModelRegistryV1({
          ...input,
          profiles: [input.profiles[0], input.profiles[0], input.profiles[2]],
        }),
      "profile_collision"
    );
    expectModelError(
      () =>
        buildScaModelRegistryV1({
          ...input,
          profiles: input.profiles.map((profile, index) =>
            index === 0 ? { ...profile, fallback_model_id: "silent-fallback" } : profile
          ),
        }),
      "invalid_registry"
    );
  });

  it("fails closed on runtime identity, schema, or budget drift", () => {
    const registry = buildScaModelRegistryV1(registryInput());
    expectModelError(
      () =>
        admitScaModelExecutionV1(registry, { ...executionRequest(), observed_model_id: "other" }),
      "runtime_identity_mismatch"
    );
    expectModelError(
      () =>
        admitScaModelExecutionV1(registry, {
          ...executionRequest(),
          output_schema_version: 2,
        }),
      "invalid_execution_request"
    );
    expectModelError(
      () =>
        admitScaModelExecutionV1(registry, {
          ...executionRequest(),
          requested_budget: { ...executionRequest().requested_budget, max_output_tokens: 12_001 },
        }),
      "budget_exceeded"
    );
  });

  it("rejects registry digest tamper before execution admission", () => {
    const registry = buildScaModelRegistryV1(registryInput());
    expectModelError(
      () => validateScaModelRegistryV1({ ...registry, registry_sha256: "0".repeat(64) }),
      "registry_digest_mismatch"
    );
  });
});
