import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseSsotTools } from "../src/model-client.js";
import { ASSESS_PLAYBOOK_REGISTRATION, ASSESS_LIVENESS_POLICY } from "../src/playbooks/assess.js";
import { DECIDE_PLAYBOOK_REGISTRATION, DECIDE_LIVENESS_POLICY } from "../src/playbooks/decide.js";
import {
  DIAGNOSE_PLAYBOOK_REGISTRATION,
  DIAGNOSE_LIVENESS_POLICY,
} from "../src/playbooks/diagnose.js";
import { PLAN_PLAYBOOK_REGISTRATION, PLAN_LIVENESS_POLICY } from "../src/playbooks/plan.js";
import {
  PRODUCE_PLAYBOOK_REGISTRATION,
  PRODUCE_LIVENESS_POLICY,
} from "../src/playbooks/produce.js";
import {
  runtimeRegistrationSha256,
  type PlaybookRegistrationV1,
} from "../src/playbooks/registry.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const UNIVERSAL_REGISTRATIONS = [
  ASSESS_PLAYBOOK_REGISTRATION,
  DECIDE_PLAYBOOK_REGISTRATION,
  DIAGNOSE_PLAYBOOK_REGISTRATION,
  PLAN_PLAYBOOK_REGISTRATION,
  PRODUCE_PLAYBOOK_REGISTRATION,
] as const;
const UNIVERSAL_LIVENESS_POLICIES = [
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
    throw new Error("catalog worker is absent");
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

describe("universal registration tool authority", () => {
  it("omits tool and browser policy narrowing from every ordinary workflow phase", () => {
    for (const registration of UNIVERSAL_REGISTRATIONS) {
      expect(registration.worker.kind).toBe("catalog-agent");
      if (registration.worker.kind !== "catalog-agent") continue;
      expect(registration.worker.phases.size).toBeGreaterThan(0);
      for (const phase of registration.worker.phases.values()) {
        expect(phase).not.toHaveProperty("allowed_tools");
        expect(phase).not.toHaveProperty("browser_network_allowlist");
        const yamlTools = declaredTools(phase.agent);
        expect(yamlTools.length).toBeGreaterThan(1);
        expect(yamlTools).toContain("artifact_read");
        expect(phase.allowed_tools ?? yamlTools).toEqual(yamlTools);
      }
    }
  });

  it("gives ordinary execution calibrated progress leases while routing repair stays at zero", () => {
    for (const policy of UNIVERSAL_LIVENESS_POLICIES) {
      expect(policy.schema_version).toBe(3);
      expect(policy.unknown_provider_phase_inactivity_ms).toBe(10 * 60_000);
      expect(policy.renewal_policy).toBe("trusted_host_activity_or_convergence_v1");
      expect("worker_active_work_budget_ms" in policy).toBe(false);
      expect("run_active_work_budget_ms" in policy).toBe(false);
      expect("external_calls_per_worker" in policy).toBe(false);
      expect(policy.routing_repair.external_calls_per_worker).toBe(0);
    }
  });

  it("changes the canonical digest when a synthetic strict phase subset is added", () => {
    const changed = replaceFirstPhaseTools(DECIDE_PLAYBOOK_REGISTRATION, ["artifact_read"]);
    expect(runtimeRegistrationSha256(changed)).not.toBe(
      runtimeRegistrationSha256(DECIDE_PLAYBOOK_REGISTRATION)
    );
  });
});
