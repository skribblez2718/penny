import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../src/canonical-json.js";
import {
  ScaFindingValidationError,
  buildScaM3ManifestV1,
  scaCandidateGapId,
  scaFindingGapId,
  sealScaFindingValidationResultV1,
  validateScaFindingValidationResultV1,
  validateScaM3ManifestV1,
} from "../src/sca/finding-validation.js";

const FINDING_ID = `scafind_${"a".repeat(64)}`;
const CANDIDATE_ID = `scaobs_${"b".repeat(64)}`;
const SNAPSHOT = "c".repeat(64);

function findingSet(options: { analysisGap?: string; unresolved?: string } = {}) {
  const evidence = {
    path: "src/app.ts",
    start_line: 10,
    end_line: 12,
    evidence_sha256: "d".repeat(64),
    claim: "Untrusted input reaches the command sink.",
    supporting_profiles: ["primary_a", "primary_b"],
  };
  const unsignedFinding = {
    finding_id: FINDING_ID,
    candidate_id: CANDIDATE_ID,
    title: "Command injection",
    weakness_id: "CWE-78",
    severity: "high",
    reachability: "reachable",
    confidence: "high",
    rationale: "The request value is interpolated into a shell command.",
    remediation: "Use a non-shell API with fixed arguments.",
    evidence: [evidence],
    analysis_gaps: options.analysisGap === undefined ? [] : [options.analysisGap],
    requested_action_count: 0,
    dissenting_profiles: [],
  };
  const finding = { ...unsignedFinding, finding_sha256: sha256(canonicalJson(unsignedFinding)) };
  const controls = [
    "source_inventory",
    "syntax_parsing",
    "static_rules",
    "secret_scanning",
    "dependency_inventory",
    "advisory_lookup",
    "deep_source_analysis",
    "independent_review",
  ].map((control_id) => ({ control_id, status: "complete", evidence_ids: [control_id] }));
  const unsigned = {
    schema_id: "penny.sca-finding-set.v1",
    schema_version: 1,
    tenant_id: "tenant-a",
    project_id: "project-a",
    run_id: "run-finding-validation",
    source_snapshot_sha256: SNAPSHOT,
    m1_manifest_sha256: "e".repeat(64),
    m2_manifest_sha256: "f".repeat(64),
    status: "derived",
    findings: [finding],
    candidate_dispositions: [
      {
        candidate_id: CANDIDATE_ID,
        disposition: "confirmed",
        severity: "high",
        reachability: "reachable",
        finding_id: FINDING_ID,
      },
    ],
    unresolved_candidate_ids: options.unresolved === undefined ? [] : [options.unresolved],
    graph_nodes: [
      { node_id: FINDING_ID, node_kind: "finding", label: "Command injection" },
      { node_id: CANDIDATE_ID, node_kind: "candidate", label: CANDIDATE_ID },
    ],
    graph_edges: [{ from_node_id: FINDING_ID, to_node_id: CANDIDATE_ID, relation: "derived_from" }],
    control_coverage: controls,
  };
  return { ...unsigned, finding_set_sha256: sha256(canonicalJson(unsigned)) };
}

function validation(
  set = findingSet(),
  verdict: "validated" | "rejected" | "inconclusive" = "validated"
) {
  const finding = set.findings[0];
  if (finding === undefined) throw new Error("finding fixture missing");
  return sealScaFindingValidationResultV1({
    schema_id: "penny.sca-finding-validation-result.v1",
    schema_version: 1,
    tenant_id: set.tenant_id,
    project_id: set.project_id,
    run_id: set.run_id,
    source_snapshot_sha256: set.source_snapshot_sha256,
    finding_set_sha256: set.finding_set_sha256,
    finding_id: finding.finding_id,
    finding_sha256: finding.finding_sha256,
    validator_profile_id: "critic",
    model_admission_sha256: "1".repeat(64),
    independent_context_sha256: "2".repeat(64),
    verdict,
    checks: {
      evidence_sufficient: verdict === "validated",
      reachability_supported: verdict === "validated",
      severity_supported: verdict === "validated",
      remediation_actionable: verdict === "validated",
    },
    rationale:
      verdict === "validated"
        ? "Independent review supports the evidence, reachability, severity, and remediation."
        : "Independent review found unresolved support gaps.",
    gaps: verdict === "validated" ? [] : ["Reachability evidence is incomplete."],
  });
}

function m3Input(
  set = findingSet(),
  validations = [validation(set)],
  gap_dispositions: unknown[] = []
) {
  return {
    schema_id: "penny.sca-m3-proof-input.v1",
    schema_version: 1,
    finding_set: set,
    validations,
    gap_dispositions,
  };
}

function expectValidationError(run: () => unknown, code: ScaFindingValidationError["code"]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaFindingValidationError);
    if (error instanceof ScaFindingValidationError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected SCA finding validation error '${code}'`);
}

describe("S-06-T4 finding validation and M3 proof gate", () => {
  it("seals independent per-finding validation and passes complete M3 proof", () => {
    const set = findingSet();
    const result = validation(set);
    expect(validateScaFindingValidationResultV1(result)).toEqual(result);
    const manifest = buildScaM3ManifestV1(m3Input(set, [result]));
    expect(manifest).toMatchObject({
      milestone: "M3_FULL_ANALYSIS",
      status: "passed",
      release_eligible: false,
      stronger_execution_authorized: false,
      validated_finding_ids: [FINDING_ID],
      blockers: [],
    });
    expect(validateScaM3ManifestV1(manifest)).toEqual(manifest);
  });

  it("blocks missing, duplicate, rejected, and drifted finding validation", () => {
    const set = findingSet();
    expect(buildScaM3ManifestV1(m3Input(set, [])).blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "missing_validation" })])
    );
    const valid = validation(set);
    expect(buildScaM3ManifestV1(m3Input(set, [valid, valid])).blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "duplicate_validation" })])
    );
    expect(buildScaM3ManifestV1(m3Input(set, [validation(set, "rejected")])).blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "finding_not_validated" })])
    );
    const { result_sha256: _digest, ...unsigned } = valid;
    const drifted = sealScaFindingValidationResultV1({
      ...unsigned,
      finding_sha256: "9".repeat(64),
    });
    expect(buildScaM3ManifestV1(m3Input(set, [drifted])).blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "validation_binding_mismatch" })])
    );
  });

  it("requires exact dispositions for unresolved candidates and finding gaps", () => {
    const unresolved = `scaobs_${"7".repeat(64)}`;
    const gapText = "Framework registration outside the snapshot may change reachability.";
    const set = findingSet({ analysisGap: gapText, unresolved });
    const missing = buildScaM3ManifestV1(m3Input(set, [validation(set)]));
    expect(missing.status).toBe("blocked");
    expect(
      missing.blockers.filter((blocker) => blocker.code === "missing_gap_disposition")
    ).toHaveLength(2);

    const dispositions = [
      {
        gap_id: scaCandidateGapId(unresolved),
        subject_id: unresolved,
        disposition: "requires_stronger_evidence",
        rationale: "A sandboxed integration harness is required.",
        evidence_sha256: null,
      },
      {
        gap_id: scaFindingGapId(FINDING_ID, gapText),
        subject_id: FINDING_ID,
        disposition: "accepted_limitation",
        rationale: "The external registration mechanism is outside the admitted snapshot.",
        evidence_sha256: null,
      },
    ];
    const manifest = buildScaM3ManifestV1(m3Input(set, [validation(set)], dispositions));
    expect(manifest).toMatchObject({
      status: "passed",
      accepted_limitation_count: 1,
      stronger_evidence_gap_count: 1,
    });
  });

  it("rejects inconsistent validation and detects digest tamper", () => {
    const set = findingSet();
    const valid = validation(set);
    const { result_sha256: _digest, ...unsigned } = valid;
    expectValidationError(
      () =>
        sealScaFindingValidationResultV1({
          ...unsigned,
          verdict: "validated",
          checks: { ...unsigned.checks, severity_supported: false },
        }),
      "invalid_validation"
    );
    expectValidationError(
      () => validateScaFindingValidationResultV1({ ...valid, result_sha256: "0".repeat(64) }),
      "validation_digest_mismatch"
    );
    const manifest = buildScaM3ManifestV1(m3Input(set, [valid]));
    expectValidationError(
      () => validateScaM3ManifestV1({ ...manifest, manifest_sha256: "0".repeat(64) }),
      "m3_manifest_digest_mismatch"
    );
  });
});
