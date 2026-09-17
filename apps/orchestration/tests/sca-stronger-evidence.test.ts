import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../src/canonical-json.js";
import {
  ScaEvidenceError,
  buildScaM4ManifestV1,
  sealScaFindingEvidenceV1,
  validateScaFindingEvidenceV1,
  validateScaM4ManifestV1,
} from "../src/sca/stronger-evidence.js";
import {
  buildScaM3ManifestV1,
  scaFindingGapId,
  sealScaFindingValidationResultV1,
} from "../src/sca/finding-validation.js";

const FINDING_ID = `scafind_${"a".repeat(64)}`;
const CANDIDATE_ID = `scaobs_${"b".repeat(64)}`;
const SNAPSHOT = "c".repeat(64);
const GAP = "Runtime registration may alter the reachable route set.";

function findingSet() {
  const unsignedFinding = {
    finding_id: FINDING_ID,
    candidate_id: CANDIDATE_ID,
    title: "Command injection",
    weakness_id: "CWE-78",
    severity: "high",
    reachability: "reachable",
    confidence: "high",
    rationale: "Untrusted input reaches a shell command.",
    remediation: "Use a non-shell process API.",
    evidence: [
      {
        path: "src/app.ts",
        start_line: 10,
        end_line: 12,
        evidence_sha256: "d".repeat(64),
        claim: "The request value is interpolated into a command.",
        supporting_profiles: ["primary_a", "primary_b"],
      },
    ],
    analysis_gaps: [GAP],
    requested_action_count: 1,
    dissenting_profiles: [],
  };
  const finding = { ...unsignedFinding, finding_sha256: sha256(canonicalJson(unsignedFinding)) };
  const controlIds = [
    "source_inventory",
    "syntax_parsing",
    "static_rules",
    "secret_scanning",
    "dependency_inventory",
    "advisory_lookup",
    "deep_source_analysis",
    "independent_review",
  ];
  const unsigned = {
    schema_id: "penny.sca-finding-set.v1",
    schema_version: 1,
    tenant_id: "tenant-a",
    project_id: "project-a",
    run_id: "run-evidence",
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
    unresolved_candidate_ids: [],
    graph_nodes: [
      { node_id: FINDING_ID, node_kind: "finding", label: "Command injection" },
      { node_id: CANDIDATE_ID, node_kind: "candidate", label: CANDIDATE_ID },
    ],
    graph_edges: [{ from_node_id: FINDING_ID, to_node_id: CANDIDATE_ID, relation: "derived_from" }],
    control_coverage: controlIds.map((control_id) => ({
      control_id,
      status: "complete",
      evidence_ids: [control_id],
    })),
  };
  return { ...unsigned, finding_set_sha256: sha256(canonicalJson(unsigned)) };
}

function fixture() {
  const set = findingSet();
  const finding = set.findings[0];
  if (finding === undefined) throw new Error("finding fixture missing");
  const validation = sealScaFindingValidationResultV1({
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
    verdict: "validated",
    checks: {
      evidence_sufficient: true,
      reachability_supported: true,
      severity_supported: true,
      remediation_actionable: true,
    },
    rationale: "Independent review validates the finding while preserving the runtime gap.",
    gaps: [],
  });
  const gapId = scaFindingGapId(FINDING_ID, GAP);
  const m3 = buildScaM3ManifestV1({
    schema_id: "penny.sca-m3-proof-input.v1",
    schema_version: 1,
    finding_set: set,
    validations: [validation],
    gap_dispositions: [
      {
        gap_id: gapId,
        subject_id: FINDING_ID,
        disposition: "requires_stronger_evidence",
        rationale: "A sandboxed harness must exercise the registered route.",
        evidence_sha256: null,
      },
    ],
  });
  return { set, m3, gapId };
}

function evidence(
  source = fixture(),
  options: {
    status?: "succeeded" | "failed";
    effect?: "resolves_gap" | "supports_finding" | "refutes_finding" | "inconclusive";
  } = {}
) {
  const status = options.status ?? "succeeded";
  const effect = options.effect ?? "resolves_gap";
  return sealScaFindingEvidenceV1({
    schema_id: "penny.sca-finding-evidence.v1",
    schema_version: 1,
    tenant_id: source.set.tenant_id,
    project_id: source.set.project_id,
    run_id: source.set.run_id,
    source_snapshot_sha256: source.set.source_snapshot_sha256,
    finding_set_sha256: source.set.finding_set_sha256,
    m3_manifest_sha256: source.m3.manifest_sha256,
    execution_id: "execution-evidence",
    execution_receipt_sha256: "3".repeat(64),
    authorization_id: `scaauth_${"4".repeat(64)}`,
    authorization_sha256: "5".repeat(64),
    human_principal_id: "operator-a",
    sandbox_profile_sha256: "6".repeat(64),
    action_plan_sha256: "7".repeat(64),
    action_type: "harness",
    execution_status: status,
    started_at: "2030-01-01T00:00:00.000Z",
    completed_at: "2030-01-01T00:01:00.000Z",
    exit_code: status === "succeeded" ? 0 : 1,
    stdout_sha256: "8".repeat(64),
    stderr_sha256: "9".repeat(64),
    finding_ids: [FINDING_ID],
    gap_ids: [source.gapId],
    effect,
    summary:
      status === "succeeded"
        ? "The sandboxed harness reached the route and reproduced the command sink."
        : "The sandboxed harness failed before the route was exercised.",
    failure_code: status === "succeeded" ? null : "harness_setup_failed",
  });
}

function m4Input(source = fixture(), entries = [evidence(source)]) {
  return {
    schema_id: "penny.sca-m4-proof-input.v1",
    schema_version: 1,
    finding_set: source.set,
    m3_manifest: source.m3,
    evidence: entries,
  };
}

function expectEvidenceError(run: () => unknown, code: ScaEvidenceError["code"]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaEvidenceError);
    if (error instanceof ScaEvidenceError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected SCA evidence error '${code}'`);
}

describe("S-07-T2 evidence attachment and M4 proof gate", () => {
  it("attaches successful authorized evidence to findings and resolves required gaps", () => {
    const source = fixture();
    const entry = evidence(source);
    expect(validateScaFindingEvidenceV1(entry)).toEqual(entry);
    const manifest = buildScaM4ManifestV1(m4Input(source, [entry]));
    expect(manifest).toMatchObject({
      milestone: "M4_STRONGER_EVIDENCE",
      status: "passed",
      release_eligible: false,
      resolved_gap_ids: [source.gapId],
      authorized_execution_count: 1,
      incomplete_attempt_count: 0,
      blockers: [],
    });
    expect(manifest.graph_edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to_node_id: FINDING_ID }),
        expect.objectContaining({ to_node_id: source.gapId, relation: "resolves" }),
      ])
    );
    expect(validateScaM4ManifestV1(manifest)).toEqual(manifest);
  });

  it("blocks missing, incomplete, inconclusive, and refuting evidence explicitly", () => {
    const source = fixture();
    expect(buildScaM4ManifestV1(m4Input(source, [])).blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "missing_required_evidence" })])
    );
    const failed = evidence(source, { status: "failed", effect: "inconclusive" });
    const failedM4 = buildScaM4ManifestV1(m4Input(source, [failed]));
    expect(failedM4.incomplete_attempt_count).toBe(1);
    expect(failedM4.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "incomplete_authorized_execution" }),
        expect.objectContaining({ code: "evidence_did_not_resolve_gap" }),
      ])
    );
    const refuting = evidence(source, { effect: "refutes_finding" });
    expect(buildScaM4ManifestV1(m4Input(source, [refuting])).blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "evidence_refutes_finding" }),
        expect.objectContaining({ code: "evidence_did_not_resolve_gap" }),
      ])
    );
  });

  it("blocks duplicate and drifted evidence targets", () => {
    const source = fixture();
    const entry = evidence(source);
    expect(buildScaM4ManifestV1(m4Input(source, [entry, entry])).blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "duplicate_evidence" })])
    );
    const { evidence_id: _id, evidence_sha256: _digest, ...unsigned } = entry;
    const drifted = sealScaFindingEvidenceV1({
      ...unsigned,
      m3_manifest_sha256: "0".repeat(64),
    });
    expect(buildScaM4ManifestV1(m4Input(source, [drifted])).blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "evidence_binding_mismatch" })])
    );
  });

  it("rejects inconsistent evidence and detects evidence and M4 tamper", () => {
    const source = fixture();
    const entry = evidence(source);
    const { evidence_id: _id, evidence_sha256: _digest, ...unsigned } = entry;
    expectEvidenceError(
      () =>
        sealScaFindingEvidenceV1({
          ...unsigned,
          execution_status: "failed",
          effect: "resolves_gap",
          failure_code: "failed",
        }),
      "invalid_evidence"
    );
    expectEvidenceError(
      () => validateScaFindingEvidenceV1({ ...entry, evidence_sha256: "0".repeat(64) }),
      "evidence_digest_mismatch"
    );
    const manifest = buildScaM4ManifestV1(m4Input(source, [entry]));
    expectEvidenceError(
      () => validateScaM4ManifestV1({ ...manifest, manifest_sha256: "0".repeat(64) }),
      "m4_manifest_digest_mismatch"
    );
  });
});
