import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../dist/checkpointer.js";
import {
  CHILD_EXECUTION_LEASE_PROFILE_V1,
  LIVENESS_CALIBRATION_SHA256,
  LIVENESS_LEASE_REGISTRY_SHA256,
  WORKER_LEASE_PROFILES_V1,
  childExecutionProgressLeaseBinding,
  resolveWorkerLeaseProfile,
  workerProgressLeaseBinding,
} from "../dist/liveness-profiles.js";

describe("immutable calibrated worker inactivity profiles", () => {
  it("selects exact provider/model profiles and conservative unknown-provider fallbacks", () => {
    expect(
      resolveWorkerLeaseProfile({
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        purpose: "phase",
      })
    ).toMatchObject({ selector: "exact", inactivity_interval_ms: 6 * 60_000 });
    expect(
      resolveWorkerLeaseProfile({
        providerId: "future-provider",
        modelId: "future-model",
        purpose: "phase",
      })
    ).toMatchObject({
      selector: "unknown_provider_fallback",
      inactivity_interval_ms: 10 * 60_000,
    });
    expect(
      resolveWorkerLeaseProfile({
        providerId: "future-provider",
        modelId: "future-model",
        purpose: "routing_repair",
      })
    ).toMatchObject({
      selector: "unknown_provider_fallback",
      inactivity_interval_ms: 3 * 60_000,
    });
  });

  it("binds the actual resolved identity without retaining content", () => {
    const binding = workerProgressLeaseBinding({
      providerId: "future-provider",
      modelId: "future-model",
      purpose: "phase",
    });
    expect(binding).toMatchObject({
      provider_id: "future-provider",
      model_id: "future-model",
      operation_class: "worker",
      inactivity_interval_ms: 10 * 60_000,
      renewal_policy: "trusted_host_activity_or_convergence_v1",
      calibration_sha256: LIVENESS_CALIBRATION_SHA256,
    });
    expect(Object.keys(binding).sort()).toEqual([
      "calibration_id",
      "calibration_sha256",
      "inactivity_interval_ms",
      "model_id",
      "operation_class",
      "profile_id",
      "profile_sha256",
      "profile_version",
      "provider_id",
      "renewal_policy",
      "schema_version",
    ]);
  });

  it("binds the depth-one child execution to its own finite inactivity profile", () => {
    expect(childExecutionProgressLeaseBinding()).toEqual(CHILD_EXECUTION_LEASE_PROFILE_V1);
    expect(childExecutionProgressLeaseBinding()).toMatchObject({
      operation_class: "child_execution",
      inactivity_interval_ms: 10 * 60_000,
    });
  });

  it("keeps every profile and the registry digest-bound", () => {
    for (const profile of WORKER_LEASE_PROFILES_V1) {
      const { profile_sha256: digest, ...definition } = profile;
      expect(digest).toBe(sha256(canonicalJson(definition)));
    }
    const { profile_sha256: childDigest, ...childDefinition } = CHILD_EXECUTION_LEASE_PROFILE_V1;
    expect(childDigest).toBe(sha256(canonicalJson(childDefinition)));
    expect(LIVENESS_CALIBRATION_SHA256).toMatch(/^[a-f0-9]{64}$/u);
    expect(LIVENESS_LEASE_REGISTRY_SHA256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
