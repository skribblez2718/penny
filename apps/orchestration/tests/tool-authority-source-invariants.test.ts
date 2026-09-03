import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const MODEL_CLIENT_SOURCE = readFileSync(
  new URL("../src/model-client.ts", import.meta.url),
  "utf8"
);
const WORKER_SOURCE = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
const REGISTRY_SOURCE = readFileSync(
  new URL("../src/playbooks/registry.ts", import.meta.url),
  "utf8"
);
const DIRECT_AGENT_RUNNER_SOURCE = readFileSync(
  new URL("../../../.pi/extensions/subagent/agent-runner.ts", import.meta.url),
  "utf8"
);
const ORDINARY_CANDIDATE_PLAYBOOK_SOURCES = ["assess", "decide", "diagnose", "plan", "produce"].map(
  (name) => readFileSync(new URL(`../src/playbooks/${name}.ts`, import.meta.url), "utf8")
);

describe("W6 closed catalog tool-authority seam", () => {
  it("keeps direct, parallel, and chain spawning on exact YAML equality", () => {
    expect(DIRECT_AGENT_RUNNER_SOURCE).toContain('args.push("--tools", agent.tools.join(","));');
    expect(DIRECT_AGENT_RUNNER_SOURCE).not.toContain("allowed_tools");
  });

  it("removes blanket candidate phase-tool constants while retaining the generic subset seam", () => {
    for (const source of ORDINARY_CANDIDATE_PLAYBOOK_SOURCES) {
      expect(source).not.toMatch(/export const [A-Z]+_CANDIDATE_PHASE_TOOLS/u);
    }
  });

  it("permits orchestration narrowing only through active registration metadata", () => {
    expect(REGISTRY_SOURCE).toContain("readonly allowed_tools?: readonly string[];");
    expect(REGISTRY_SOURCE).toContain("allowed_tools: phase.allowed_tools ?? null");
    expect(WORKER_SOURCE).toContain(
      'const allowedTools = "allowed_tools" in phase ? phase.allowed_tools : undefined;'
    );
    expect(WORKER_SOURCE).toContain("{ allowed_tools: [...allowedTools] }");
    expect(MODEL_CLIENT_SOURCE).toContain("const registeredSubset = registration.allowed_tools;");
    expect(MODEL_CLIENT_SOURCE).toContain(": registeredSubset === undefined");
    expect(MODEL_CLIENT_SOURCE).toContain(": [...registeredSubset];");
    expect(MODEL_CLIENT_SOURCE).toContain("tools: allowed,");
    expect(MODEL_CLIENT_SOURCE).not.toMatch(
      /(?:trustProfile|invocation\.task).*registeredSubset|registeredSubset.*(?:trustProfile|invocation\.task)/u
    );
  });
});
