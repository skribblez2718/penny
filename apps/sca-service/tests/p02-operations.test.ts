import { describe, expect, it } from "vitest";

import {
  buildScaP02RawEvidenceV1,
  deriveScaP02ProvenanceV1,
} from "../../orchestration/dist/sca/p02-contracts.js";
import {
  createScaP02OperationAdaptersV1,
  minimizeScaP02GitleaksEvidenceV1,
  selectScaP02ScannerRulesV1,
} from "../src/p02-operations.js";

describe("inactive SCA P02 service operation composition", () => {
  it("constructs six injected host-operation adapters without invoking a scanner or transport", () => {
    let isolationCalls = 0;
    const adapters = createScaP02OperationAdaptersV1({
      isolation: {
        isolation_id: "deterministic-test-isolation",
        runtime_id: "deterministic-test-runtime",
        implementation_identity_sha256: "b".repeat(64),
        deployment_identity_sha256: "c".repeat(64),
        profile_id: "deterministic-test-profile",
        profile_sha256: "a".repeat(64),
        qualification_scope: "deterministic_test_only",
        runtime_kind: "simulated_test_runtime",
        simulation_label: "simulated_test_seam",
        async run({ execute }) {
          isolationCalls += 1;
          return execute();
        },
      },
    });
    expect([...adapters.keys()].sort()).toEqual([
      "sca-p02-gitleaks-adapter-v1",
      "sca-p02-inventory-adapter-v1",
      "sca-p02-osv-composer-adapter-v1",
      "sca-p02-osv-npm-adapter-v1",
      "sca-p02-semgrep-js-ts-adapter-v1",
      "sca-p02-semgrep-php-adapter-v1",
    ]);
    expect(isolationCalls).toBe(0);
  });

  it("excludes the Gitleaks configuration rule from Semgrep selections", () => {
    const rules = [
      { rule_id: "php-taint", language: "php" },
      { rule_id: "js-prototype-pollution", language: "javascript" },
      { rule_id: "gitleaks-configuration", language: "php" },
    ];
    const selected = rules.map((rule) => rule.rule_id);
    expect(
      selectScaP02ScannerRulesV1({
        rules,
        selected_rule_ids: selected,
        languages: ["php"],
        excluded_rule_ids: ["gitleaks-configuration"],
      }).map((rule) => rule.rule_id)
    ).toEqual(["php-taint"]);
    expect(
      selectScaP02ScannerRulesV1({
        rules,
        selected_rule_ids: selected,
        languages: ["javascript", "typescript"],
        excluded_rule_ids: ["gitleaks-configuration"],
      }).map((rule) => rule.rule_id)
    ).toEqual(["js-prototype-pollution"]);
  });

  it("derives Gitleaks and OSV observations from decoded component records", () => {
    const gitleaks = buildScaP02RawEvidenceV1({
      analyzer_id: "gitleaks",
      retention: "minimized",
      original_content_sha256: "a".repeat(64),
      original_byte_length: 100,
      value: {
        schema_id: "penny.sca-p02-gitleaks-minimized-result.v1",
        schema_version: 1,
        findings: [
          {
            rule_id: "generic-api-key",
            file: "config/example.env",
            start_line: 7,
            end_line: 7,
            original_fingerprint_sha256: "b".repeat(64),
          },
        ],
      },
    });
    const osv = buildScaP02RawEvidenceV1({
      analyzer_id: "osv-npm",
      value: {
        schema_id: "penny.sca-osv-result.v2",
        schema_version: 2,
        advisory_occurrences: [
          { advisory_id: "GHSA-example", occurrence_ids: ["occurrence-a", "occurrence-b"] },
        ],
      },
    });
    const graph = deriveScaP02ProvenanceV1({
      raw_evidence: [gitleaks.evidence, osv.evidence],
      raw_records: [...gitleaks.raw_records, ...osv.raw_records],
    });
    expect(graph.normalized_observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          analyzer_id: "gitleaks",
          category: "generic-api-key",
          severity: "high",
          path: "config/example.env",
          start_line: 7,
        }),
        expect.objectContaining({
          analyzer_id: "osv-npm",
          category: "vulnerability",
          advisory_id: "GHSA-example",
          subject: "GHSA-example:2",
        }),
      ])
    );
    expect(graph.correlations).toHaveLength(2);
  });

  it("minimizes Gitleaks findings without retaining secret-bearing fields", () => {
    const minimized = minimizeScaP02GitleaksEvidenceV1(
      JSON.stringify([
        {
          RuleID: "generic-api-key",
          File: "config/example.env",
          StartLine: 7,
          EndLine: 7,
          Secret: "do-not-retain-this-secret",
          Match: "TOKEN=do-not-retain-this-secret",
          Entropy: 4.7,
        },
      ]),
      {
        source_snapshot_sha256: "a".repeat(64),
        configuration_sha256: "b".repeat(64),
        status: "findings",
        tool_version: "1",
        runtime_identity: "test",
        runtime_sha256: "c".repeat(64),
        invocation_sha256: "d".repeat(64),
        exit_code: 1,
        error_code: "none",
        finding_count: 1,
        raw_stdout_sha256: "e".repeat(64),
        raw_stderr_sha256: "f".repeat(64),
        truncated: false,
      }
    );
    const serialized = JSON.stringify(minimized);
    expect(minimized).toMatchObject({
      schema_id: "penny.sca-p02-gitleaks-minimized-result.v1",
      schema_version: 1,
      status: "findings",
      finding_count: 1,
      findings: [
        {
          rule_id: "generic-api-key",
          file: "config/example.env",
          start_line: 7,
          end_line: 7,
        },
      ],
    });
    expect(minimized.findings[0]?.original_fingerprint_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(serialized).not.toContain("do-not-retain-this-secret");
    expect(serialized).not.toContain("TOKEN=");
    expect(serialized).not.toContain("Entropy");
  });
});
