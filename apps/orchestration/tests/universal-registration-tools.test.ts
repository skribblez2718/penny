import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseSsotTools } from "../dist/model-client.js";
import { ASSESS_PLAYBOOK_REGISTRATION, ASSESS_LIVENESS_POLICY } from "../dist/playbooks/assess.js";
import { DECIDE_PLAYBOOK_REGISTRATION, DECIDE_LIVENESS_POLICY } from "../dist/playbooks/decide.js";
import {
  DIAGNOSE_PLAYBOOK_REGISTRATION,
  DIAGNOSE_LIVENESS_POLICY,
} from "../dist/playbooks/diagnose.js";
import { PLAN_PLAYBOOK_REGISTRATION, PLAN_LIVENESS_POLICY } from "../dist/playbooks/plan.js";
import {
  PRODUCE_PLAYBOOK_REGISTRATION,
  PRODUCE_LIVENESS_POLICY,
} from "../dist/playbooks/produce.js";
import {
  PLAYBOOK_REGISTRY,
  runtimeRegistrationSha256,
  type PlaybookRegistration,
} from "../dist/playbooks/registry.js";

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
  registration: PlaybookRegistration,
  allowedTools: readonly string[]
): PlaybookRegistration {
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
  it("pins every active catalog phase to its existing YAML or explicit artifact-only registration", () => {
    const catalogRegistrations = [...PLAYBOOK_REGISTRY.values()].filter(
      (registration) => registration.worker.kind === "catalog-agent"
    );
    expect(catalogRegistrations.map((registration) => registration.name).sort()).toEqual([
      "assess",
      "decide",
      "define",
      "diagnose",
      "imagegen",
      "plan",
      "produce",
      "research",
      "sca",
      // Hidden from model discovery, but still a catalog worker with exact YAML authority.
      "videogen",
    ]);
    for (const registration of catalogRegistrations) {
      if (registration.worker.kind !== "catalog-agent") throw new Error("catalog worker missing");
      expect(registration.worker.phases.size, registration.name).toBeGreaterThan(0);
      for (const [state, phase] of registration.worker.phases) {
        const label = `${registration.name}/${state}`;
        const yamlTools = declaredTools(phase.agent);
        if (registration.name === "sca" || registration.name === "imagegen") {
          expect(phase.allowed_tools, label).toEqual(["artifact_read"]);
          expect(yamlTools, label).toContain("artifact_read");
          expect(yamlTools.length, label).toBeGreaterThan(phase.allowed_tools?.length ?? 0);
        } else {
          expect(phase, label).not.toHaveProperty("allowed_tools");
          expect(phase.allowed_tools ?? yamlTools, label).toEqual(yamlTools);
        }
      }
    }
  });

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

  it("gives ordinary execution calibrated progress leases without inventing correction allowances", () => {
    for (const policy of UNIVERSAL_LIVENESS_POLICIES) {
      expect(policy.schema_version).toBe(3);
      expect(policy.unknown_provider_phase_inactivity_ms).toBe(10 * 60_000);
      expect(policy.renewal_policy).toBe("trusted_host_activity_or_convergence_v1");
      expect("worker_active_work_budget_ms" in policy).toBe(false);
      expect("run_active_work_budget_ms" in policy).toBe(false);
      expect("external_calls_per_worker" in policy).toBe(false);
      // These are unspecified operator allowances, not a tool-authority grant.
      // Actual phase tools remain bound separately by the registration/YAML checks above.
      expect(policy.routing_repair.max_invocations_per_state_branch).toBeNull();
      expect(policy.routing_repair.model_turns_per_worker).toBeNull();
      expect(policy.routing_repair.tool_calls_per_worker).toBeNull();
      expect(policy.routing_repair.external_calls_per_worker).toBeNull();
    }
  });

  it("changes the canonical digest when a synthetic strict phase subset is added", () => {
    const changed = replaceFirstPhaseTools(DECIDE_PLAYBOOK_REGISTRATION, ["artifact_read"]);
    expect(runtimeRegistrationSha256(changed)).not.toBe(
      runtimeRegistrationSha256(DECIDE_PLAYBOOK_REGISTRATION)
    );
  });
});
