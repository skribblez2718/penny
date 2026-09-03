/**
 * §5.13 package-surface decision/oracle contract coverage.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  GateDecisionError,
  assertPackageSurfaceDecision,
  bunPackFilesFromExecution,
  parseBunPackDryRun,
  parseGateDecisionReceiptJcs,
  validatePackageSurfaceDecision,
} from "../src/kb/gate-decisions.js";
import { canonicalJson, sha256Hex, type PackageSurfaceDecisionV1 } from "../src/kb/contracts.js";

const PACKAGE_INTERNAL_P2_MODULES = [
  "./research-context.js",
  "./skill-contracts/common.js",
  "./skill-contracts/research.js",
] as const;

function sourceIndexReexports(): readonly string[] {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  return [
    ...source.matchAll(/^export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["'];$/gmu),
  ]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined);
}

function rereviewPackageDecision(
  decision: PackageSurfaceDecisionV1,
  patch: Partial<PackageSurfaceDecisionV1>
): PackageSurfaceDecisionV1 {
  const { review_sha256: _review, ...base } = { ...decision, ...patch };
  return { ...base, review_sha256: sha256Hex(canonicalJson(base)) };
}

function reviewedPackageDecision(): PackageSurfaceDecisionV1 {
  const unreviewed = {
    schema_version: 1 as const,
    plan_id: "hybrid-kb-ts-plan-2026-08-13" as const,
    decision_id: "package_fixture",
    approved_by_subject_id: "operator",
    approved_at: "2026-08-01T00:00:00Z",
    reviewed_by_subject_id: "agent:vera",
    reviewed_at: "2026-08-01T00:01:00Z",
    evidence_refs: [],
    decision_kind: "package_surface" as const,
    package_name: "@penny/fixture",
    package_version: "1.0.0",
    package_private: true as const,
    exports: { ".": "./dist/index.js" },
    bin: { fixture: "./dist/cli.js" },
    scripts: { build: "tsc" },
    expected_pack_files: ["dist/cli.js", "dist/index.js", "package.json"],
  };
  return {
    ...unreviewed,
    review_sha256: sha256Hex(canonicalJson(unreviewed)),
  };
}

describe("§5.13 package-surface contract/oracle", () => {
  it("keeps approved packed P2 modules package-internal", () => {
    const reexports = sourceIndexReexports();
    for (const moduleSpecifier of PACKAGE_INTERNAL_P2_MODULES) {
      expect(reexports).not.toContain(moduleSpecifier);
    }
  });

  it("accepts exact closed JCS and exact live fields/files", () => {
    const decision = reviewedPackageDecision();
    const parsed = parseGateDecisionReceiptJcs(canonicalJson(decision));
    expect(parsed).toEqual(decision);
    expect(() =>
      assertPackageSurfaceDecision({
        decision,
        packageJson: {
          name: "@penny/fixture",
          version: "1.0.0",
          private: true,
          exports: { ".": "./dist/index.js" },
          bin: { fixture: "./dist/cli.js" },
          scripts: { build: "tsc" },
          unrelated_package_metadata: "not part of the reviewed projection",
        },
        packFiles: ["package.json", "dist/index.js", "dist/cli.js"],
      })
    ).not.toThrow();
  });

  it("rejects duplicate members, unknown receipt keys, non-JCS, unsafe lists, and drift", () => {
    const decision = reviewedPackageDecision();
    const jcs = canonicalJson(decision);
    expect(() =>
      parseGateDecisionReceiptJcs(jcs.replace('{"approved_at"', '{"approved_at":"x","approved_at"'))
    ).toThrow(/duplicate/u);
    expect(() =>
      parseGateDecisionReceiptJcs(jcs.replace(/\}$/u, ',"ordering_note":"not a contract field"}'))
    ).toThrow();
    expect(() => parseGateDecisionReceiptJcs(JSON.stringify(decision, null, 2))).toThrow(
      /exact JCS/u
    );
    expect(() =>
      validatePackageSurfaceDecision(
        rereviewPackageDecision(decision, {
          expected_pack_files: ["../escape", "dist/index.js"],
        })
      )
    ).toThrow(/relative path/u);
    expect(() =>
      assertPackageSurfaceDecision({
        decision,
        packageJson: {
          name: "@penny/fixture",
          version: "1.0.1",
          private: true,
          exports: { ".": "./dist/index.js" },
          bin: { fixture: "./dist/cli.js" },
          scripts: { build: "tsc" },
        },
        packFiles: decision.expected_pack_files,
      })
    ).toThrow(/does not exactly match/u);
  });

  it("treats unavailable/unparseable/duplicate bun pack evidence as hard failure", () => {
    expect(() =>
      bunPackFilesFromExecution({
        status: null,
        stdout: "",
        stderr: "",
        error: new Error("bun unavailable"),
      })
    ).toThrow(/bun unavailable/u);
    expect(() =>
      bunPackFilesFromExecution({
        status: 1,
        stdout: "",
        stderr: "pack failed",
      })
    ).toThrow(/pack failed/u);
    expect(() => parseBunPackDryRun("bun: command not found\n")).toThrow(GateDecisionError);
    expect(() => parseBunPackDryRun("package packed successfully\n")).toThrow(/zero files/u);
    expect(() =>
      parseBunPackDryRun("packed 1KB dist/index.js\npacked 1KB dist/index.js\n")
    ).toThrow(/duplicate/u);
  });
});
