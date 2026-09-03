import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseSsotTools } from "../src/model-client.js";
import { ASSESS_CANDIDATE_REGISTRATION, ASSESS_LIVENESS_POLICY } from "../src/playbooks/assess.js";
import { DECIDE_CANDIDATE_REGISTRATION, DECIDE_LIVENESS_POLICY } from "../src/playbooks/decide.js";
import {
  DIAGNOSE_CANDIDATE_REGISTRATION,
  DIAGNOSE_LIVENESS_POLICY,
} from "../src/playbooks/diagnose.js";
import { PLAN_CANDIDATE_REGISTRATION, PLAN_LIVENESS_POLICY } from "../src/playbooks/plan.js";
import {
  PRODUCE_CANDIDATE_REGISTRATION,
  PRODUCE_LIVENESS_POLICY,
} from "../src/playbooks/produce.js";
import {
  runtimeRegistrationSha256,
  type PlaybookRegistrationV1,
} from "../src/playbooks/registry.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CANDIDATE_REGISTRATIONS = [
  ASSESS_CANDIDATE_REGISTRATION,
  DECIDE_CANDIDATE_REGISTRATION,
  DIAGNOSE_CANDIDATE_REGISTRATION,
  PLAN_CANDIDATE_REGISTRATION,
  PRODUCE_CANDIDATE_REGISTRATION,
] as const;
const CANDIDATE_LIVENESS_POLICIES = [
  ASSESS_LIVENESS_POLICY,
  DECIDE_LIVENESS_POLICY,
  DIAGNOSE_LIVENESS_POLICY,
  PLAN_LIVENESS_POLICY,
  PRODUCE_LIVENESS_POLICY,
] as const;

function declaredTools(agent: string): readonly string[] {
  return parseSsotTools(
    readFileSync(path.join(PROJECT_ROOT, ".pi", "agents", `${agent}.md`), "utf8"),
    agent
  );
}

function replaceFirstPhaseTools(
  registration: PlaybookRegistrationV1,
  allowedTools: readonly string[]
): PlaybookRegistrationV1 {
  if (registration.worker.kind !== "catalog-agent") {
    throw new Error("candidate catalog worker is absent");
  }
  let replaced = false;
  const phases = new Map(
    [...registration.worker.phases.entries()].map(([stateId, phase]) => {
      if (replaced) return [stateId, phase] as const;
      replaced = true;
      return [stateId, { ...phase, allowed_tools: allowedTools }] as const;
    })
  );
  return {
    ...registration,
    worker: {
      ...registration.worker,
      phases,
    },
  };
}

describe("candidate registration tool authority", () => {
  it("omits allowed_tools from every ordinary candidate phase so exact agent YAML applies", () => {
    for (const registration of CANDIDATE_REGISTRATIONS) {
      expect(registration.worker.kind).toBe("catalog-agent");
      if (registration.worker.kind !== "catalog-agent") continue;
      expect(registration.worker.phases.size).toBeGreaterThan(0);
      for (const phase of registration.worker.phases.values()) {
        expect(phase).not.toHaveProperty("allowed_tools");
        const yamlTools = declaredTools(phase.agent);
        expect(yamlTools.length).toBeGreaterThan(1);
        expect(yamlTools).toContain("artifact_read");
        expect(phase.allowed_tools ?? yamlTools).toEqual(yamlTools);
      }
    }
  });

  it("gives normal candidate work bounded external capacity while routing repair stays at zero", () => {
    for (const policy of CANDIDATE_LIVENESS_POLICIES) {
      expect(policy.external_calls_per_worker).toBe(8);
      expect(policy.external_calls_per_run).toBe(64);
      expect(policy.routing_repair.external_calls_per_worker).toBe(0);
    }
  });

  it("changes the canonical digest when a synthetic strict phase subset is added", () => {
    const changed = replaceFirstPhaseTools(DECIDE_CANDIDATE_REGISTRATION, ["artifact_read"]);
    expect(runtimeRegistrationSha256(changed)).not.toBe(
      runtimeRegistrationSha256(DECIDE_CANDIDATE_REGISTRATION)
    );
  });
});
