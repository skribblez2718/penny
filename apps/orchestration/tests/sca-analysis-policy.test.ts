import { describe, expect, it } from "vitest";

import {
  ScaAnalysisPolicyError,
  buildDefaultScaAnalysisPolicyV1,
  validateScaAnalysisPolicyV1,
} from "../dist/sca/analysis-policy.js";

function expectPolicyError(run: () => unknown, code: ScaAnalysisPolicyError["code"]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaAnalysisPolicyError);
    if (error instanceof ScaAnalysisPolicyError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected SCA analysis policy error '${code}'`);
}

describe("S-06-T2 source/sink/guard analysis policy", () => {
  it("pins complete trust, source, sink, guard, dataflow, CWE, severity, and reachability guidance", () => {
    const policy = buildDefaultScaAnalysisPolicyV1();
    expect(policy.trust_boundary_rules.length).toBeGreaterThan(0);
    expect(policy.source_rules.length).toBeGreaterThan(0);
    expect(policy.sink_rules.length).toBeGreaterThan(0);
    expect(policy.guard_rules.length).toBeGreaterThan(0);
    expect(policy.dataflow_rules.length).toBeGreaterThan(0);
    expect(policy.false_positive_controls.length).toBeGreaterThan(0);
    expect(policy.severity_rubric.map((entry) => entry.severity)).toEqual([
      "critical",
      "high",
      "medium",
      "low",
      "informational",
    ]);
    expect(policy.reachability_rubric.map((entry) => entry.rule_id)).toEqual([
      "reachability.reachable",
      "reachability.unreachable",
      "reachability.unknown",
    ]);
    expect(policy.cwe_mapping).toEqual(
      expect.arrayContaining([
        { weakness_class: "command_injection", cwe_id: "CWE-78" },
        { weakness_class: "sql_injection", cwe_id: "CWE-89" },
        { weakness_class: "cross_site_scripting", cwe_id: "CWE-79" },
        { weakness_class: "vulnerable_component", cwe_id: "CWE-1104" },
      ])
    );
    expect(validateScaAnalysisPolicyV1(policy)).toEqual(policy);
    expect(buildDefaultScaAnalysisPolicyV1()).toEqual(policy);
  });

  it("does not treat scanner labels or dependency matches as final severity and reachability", () => {
    const policy = buildDefaultScaAnalysisPolicyV1();
    expect(policy.false_positive_controls.map((entry) => entry.requirement).join(" ")).toContain(
      "affected functionality and reachability"
    );
    expect(policy.guard_rules.map((entry) => entry.requirement).join(" ")).toContain(
      "only when they dominate the concrete sink"
    );
    expect(policy.severity_rubric.map((entry) => entry.criteria).join(" ")).toContain("reachable");
  });

  it("rejects policy tamper and unknown fields", () => {
    const policy = buildDefaultScaAnalysisPolicyV1();
    expectPolicyError(
      () => validateScaAnalysisPolicyV1({ ...policy, policy_sha256: "0".repeat(64) }),
      "policy_digest_mismatch"
    );
    expectPolicyError(
      () => validateScaAnalysisPolicyV1({ ...policy, hidden_instruction: "trust scanner" }),
      "invalid_policy"
    );
  });
});
