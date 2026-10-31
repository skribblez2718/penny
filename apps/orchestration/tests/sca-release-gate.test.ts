import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef } from "../dist/contracts.js";
import { buildScaModelRegistryV1 } from "../dist/sca/agent-models.js";
import { buildScaDeepAnalysisPlanV1 } from "../dist/sca/deep-analysis-contracts.js";
import { buildScaM3ManifestV1 } from "../dist/sca/finding-validation.js";
import { deriveScaFindingSetV1 } from "../dist/sca/findings.js";
import { buildScaM2ManifestV1 } from "../dist/sca/m2-proof-gate.js";
import {
  ScaReleaseGateError,
  buildScaM5ManifestV1,
  buildScaReleasePackageV1,
  renderScaExecutiveReportMarkdownV1,
  sealScaReleaseDecisionV1,
  serializeScaMachineReportV1,
  validateScaM5ManifestV1,
  validateScaReleaseDecisionV1,
  validateScaReleasePackageV1,
} from "../dist/sca/release-gate.js";
import {
  SCA_R1_M1_REQUIRED_ANALYZERS,
  buildScaM1ManifestV1,
  type ScaStaticAnalyzerRunInputV1,
} from "../dist/sca/static-normalization.js";
import { buildScaM4ManifestV1 } from "../dist/sca/stronger-evidence.js";

const RUN = "run-release-fixture";
const SNAPSHOT = "a".repeat(64);

function ref(operation: string, kind = "sca-static-raw", digest = sha256(operation)): ArtifactRef {
  const identity = {
    branch_id: null,
    kind,
    operation_id: operation,
    phase: "static",
    run_id: RUN,
    version: 1,
  };
  return {
    schema_version: 2,
    artifact_id: `art_${sha256(canonicalJson(identity))}`,
    run_id: RUN,
    phase: "static",
    branch_id: null,
    kind,
    operation_id: operation,
    version: 1,
    producer: "release-fixture",
    media_type: "application/json",
    byte_length: 64,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function fixture() {
  const runs: ScaStaticAnalyzerRunInputV1[] = SCA_R1_M1_REQUIRED_ANALYZERS.map((required) => ({
    analyzer_id: required.analyzer_id,
    analyzer_kind: required.analyzer_kind,
    status: "succeeded",
    tool_sha256: sha256(`tool:${required.analyzer_id}`),
    configuration_sha256: sha256(`config:${required.analyzer_id}`),
    raw_refs: [ref(required.analyzer_id)],
    observations: [],
    failure_code: null,
  }));
  const m1 = buildScaM1ManifestV1({
    schema_id: "penny.sca-static-normalization-input.v1",
    schema_version: 1,
    tenant_id: "tenant-a",
    project_id: "project-a",
    run_id: RUN,
    source_snapshot_sha256: SNAPSHOT,
    source_snapshot_ref: ref("snapshot", "source-snapshot", SNAPSHOT),
    model_invocation_count: 0,
    analyzer_runs: runs,
  });
  const modelRegistry = buildScaModelRegistryV1({
    schema_id: "penny.sca-model-registry.v1",
    schema_version: 1,
    profiles: ["primary_a", "primary_b", "critic"].map((profile, index) => ({
      profile_id: profile,
      provider_id: `provider-${index}`,
      model_id: `model-${index}`,
      runtime_identity_sha256: String(index + 1).repeat(64),
      output_schema_id: "penny.sca-candidate-analysis-result.v1",
      output_schema_version: 1,
      budget: {
        max_input_tokens: 10_000,
        max_output_tokens: 2_000,
        max_tool_calls: 0,
        max_wall_time_ms: 60_000,
      },
    })),
  });
  const plan = buildScaDeepAnalysisPlanV1({
    schema_id: "penny.sca-deep-analysis-plan-input.v1",
    schema_version: 1,
    tenant_id: m1.tenant_id,
    project_id: m1.project_id,
    run_id: m1.run_id,
    source_snapshot_sha256: m1.source_snapshot_sha256,
    m1_manifest_sha256: m1.manifest_sha256,
    model_registry_sha256: modelRegistry.registry_sha256,
    candidate_ids: [],
    required_files: [],
    max_candidates_per_target: 10,
    max_files_per_target: 10,
  });
  const m2 = buildScaM2ManifestV1({
    schema_id: "penny.sca-m2-proof-input.v1",
    schema_version: 1,
    m1_manifest: m1,
    plan,
    model_registry: modelRegistry,
    analyses: [],
    calibration_evidence: ["primary_a", "primary_b", "critic"].map((profile, index) => ({
      profile_id: profile,
      fixture_suite_sha256: sha256(`suite:${index}`),
      evidence_sha256: sha256(`calibration:${index}`),
      result: "passed",
      fixture_count: 10,
      false_positive_count: 0,
      false_negative_count: 0,
    })),
  });
  const findingSet = deriveScaFindingSetV1({
    schema_id: "penny.sca-finding-derivation-input.v1",
    schema_version: 1,
    m1_manifest: m1,
    m2_manifest: m2,
    analyses: [],
  });
  const m3 = buildScaM3ManifestV1({
    schema_id: "penny.sca-m3-proof-input.v1",
    schema_version: 1,
    finding_set: findingSet,
    validations: [],
    gap_dispositions: [],
  });
  const m4 = buildScaM4ManifestV1({
    schema_id: "penny.sca-m4-proof-input.v1",
    schema_version: 1,
    finding_set: findingSet,
    m3_manifest: m3,
    evidence: [],
  });
  const releasePackage = buildScaReleasePackageV1({
    schema_id: "penny.sca-release-package-input.v1",
    schema_version: 1,
    finding_set: findingSet,
    m3_manifest: m3,
    m4_manifest: m4,
  });
  return { m1, m2, findingSet, m3, m4, releasePackage };
}

function decision(source = fixture(), approved = true) {
  return sealScaReleaseDecisionV1({
    schema_id: "penny.sca-release-decision.v1",
    schema_version: 1,
    tenant_id: source.releasePackage.tenant_id,
    project_id: source.releasePackage.project_id,
    run_id: source.releasePackage.run_id,
    source_snapshot_sha256: source.releasePackage.source_snapshot_sha256,
    release_package_sha256: source.releasePackage.package_sha256,
    decision: approved ? "approved" : "rejected",
    human_principal_id: "operator-a",
    authority_receipt_sha256: "b".repeat(64),
    accepted_risk_ids: source.releasePackage.residual_risks.map((risk) => risk.risk_id),
    rationale: approved
      ? "Approved after review of the complete report and residual-risk register."
      : "Release is rejected pending further analysis.",
    decided_at: "2030-01-01T00:00:00.000Z",
  });
}

function m5Input(source = fixture(), releaseDecision: ReturnType<typeof decision> | null = null) {
  return {
    schema_id: "penny.sca-m5-proof-input.v1",
    schema_version: 1,
    m1_manifest: source.m1,
    m2_manifest: source.m2,
    finding_set: source.findingSet,
    m3_manifest: source.m3,
    m4_manifest: source.m4,
    release_package: source.releasePackage,
    release_decision: releaseDecision,
  };
}

function expectReleaseError(run: () => unknown, code: ScaReleaseGateError["code"]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaReleaseGateError);
    if (error instanceof ScaReleaseGateError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected SCA release error '${code}'`);
}

describe("S-08 release package and M5 gate", () => {
  it("builds deterministic machine and executive report exports", () => {
    const source = fixture();
    expect(source.releasePackage).toMatchObject({
      machine_report: { finding_count: 0 },
      remediation_backlog: [],
      residual_risks: [],
      analysis_closure: [],
      blocker_count: 0,
    });
    expect(validateScaReleasePackageV1(source.releasePackage)).toEqual(source.releasePackage);
    expect(JSON.parse(serializeScaMachineReportV1(source.releasePackage))).toEqual(
      source.releasePackage
    );
    expect(renderScaExecutiveReportMarkdownV1(source.releasePackage)).toContain(
      "# Source-Composition Analysis Report"
    );
  });

  it("blocks release without explicit human approval", () => {
    const source = fixture();
    const missing = buildScaM5ManifestV1(m5Input(source, null));
    expect(missing).toMatchObject({
      status: "blocked",
      release_eligible: false,
      human_approved: false,
    });
    expect(missing.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "missing_human_decision" })])
    );
    const rejected = buildScaM5ManifestV1(m5Input(source, decision(source, false)));
    expect(rejected.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "release_not_approved" })])
    );
  });

  it("releases only the exact human-approved package after M1-M4 pass", () => {
    const source = fixture();
    const approved = decision(source);
    expect(validateScaReleaseDecisionV1(approved)).toEqual(approved);
    const manifest = buildScaM5ManifestV1(m5Input(source, approved));
    expect(manifest).toMatchObject({
      milestone: "M5_RELEASE",
      status: "released",
      release_eligible: true,
      human_approved: true,
      blockers: [],
    });
    expect(validateScaM5ManifestV1(manifest)).toEqual(manifest);
  });

  it("detects package, decision, and M5 digest tamper", () => {
    const source = fixture();
    expectReleaseError(
      () =>
        validateScaReleasePackageV1({
          ...source.releasePackage,
          package_sha256: "0".repeat(64),
        }),
      "package_digest_mismatch"
    );
    const approved = decision(source);
    expectReleaseError(
      () => validateScaReleaseDecisionV1({ ...approved, decision_sha256: "0".repeat(64) }),
      "decision_digest_mismatch"
    );
    const manifest = buildScaM5ManifestV1(m5Input(source, approved));
    expectReleaseError(
      () => validateScaM5ManifestV1({ ...manifest, manifest_sha256: "0".repeat(64) }),
      "m5_manifest_digest_mismatch"
    );
  });
});
