import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract } from "../contracts.js";
import { OpaqueIdSchema, Sha256Schema } from "../skill-contracts/common.js";
import {
  ScaCandidateAnalysisResultV1Schema,
  validateScaCandidateAnalysisResultV1,
  type ScaCandidateAnalysisResultV1,
} from "./deep-analysis-contracts.js";
import {
  ScaM2ManifestV1Schema,
  validateScaM2ManifestV1,
  type ScaM2ManifestV1,
} from "./m2-proof-gate.js";
import {
  ScaM1ManifestV1Schema,
  validateScaM1ManifestV1,
  type ScaM1ManifestV1,
} from "./static-normalization.js";

const MAX_ITEMS = 100_000;
const MAX_TEXT = 8_192;

export const SCA_FINDING_DERIVATION_INPUT_SCHEMA = "penny.sca-finding-derivation-input.v1";
export const SCA_FINDING_SET_SCHEMA = "penny.sca-finding-set.v1";

const ScaSeverityV1Schema = Type.Union([
  Type.Literal("critical"),
  Type.Literal("high"),
  Type.Literal("medium"),
  Type.Literal("low"),
  Type.Literal("informational"),
  Type.Literal("unknown"),
]);
const ScaReachabilityV1Schema = Type.Union([
  Type.Literal("reachable"),
  Type.Literal("unreachable"),
  Type.Literal("unknown"),
]);
const ScaDispositionV1Schema = Type.Union([
  Type.Literal("confirmed"),
  Type.Literal("rejected"),
  Type.Literal("inconclusive"),
]);

export const ScaFindingDerivationInputV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_FINDING_DERIVATION_INPUT_SCHEMA),
    schema_version: Type.Literal(1),
    m1_manifest: ScaM1ManifestV1Schema,
    m2_manifest: ScaM2ManifestV1Schema,
    analyses: Type.Array(ScaCandidateAnalysisResultV1Schema, { maxItems: MAX_ITEMS }),
  },
  { additionalProperties: false }
);

const ScaFindingEvidenceV1Schema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
    start_line: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    end_line: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    evidence_sha256: Sha256Schema,
    claim: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    supporting_profiles: Type.Array(
      Type.Union([Type.Literal("primary_a"), Type.Literal("primary_b"), Type.Literal("critic")]),
      { minItems: 1, maxItems: 3 }
    ),
  },
  { additionalProperties: false }
);

const ScaFindingV1Schema = Type.Object(
  {
    finding_id: Type.String({ pattern: "^scafind_[a-f0-9]{64}$" }),
    candidate_id: OpaqueIdSchema,
    title: Type.String({ minLength: 1, maxLength: 512 }),
    weakness_id: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
    severity: ScaSeverityV1Schema,
    reachability: ScaReachabilityV1Schema,
    confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    rationale: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    remediation: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    evidence: Type.Array(ScaFindingEvidenceV1Schema, { minItems: 1, maxItems: MAX_ITEMS }),
    analysis_gaps: Type.Array(Type.String({ minLength: 1, maxLength: MAX_TEXT }), {
      maxItems: MAX_ITEMS,
    }),
    requested_action_count: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    dissenting_profiles: Type.Array(
      Type.Union([Type.Literal("primary_a"), Type.Literal("primary_b"), Type.Literal("critic")]),
      { maxItems: 3 }
    ),
    finding_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const ScaCandidateDispositionV1Schema = Type.Object(
  {
    candidate_id: OpaqueIdSchema,
    disposition: ScaDispositionV1Schema,
    severity: ScaSeverityV1Schema,
    reachability: ScaReachabilityV1Schema,
    finding_id: Type.Union([Type.String({ pattern: "^scafind_[a-f0-9]{64}$" }), Type.Null()]),
  },
  { additionalProperties: false }
);

const ScaFindingGraphNodeV1Schema = Type.Object(
  {
    node_id: Type.String({ minLength: 1, maxLength: 512 }),
    node_kind: Type.Union([
      Type.Literal("finding"),
      Type.Literal("candidate"),
      Type.Literal("source_file"),
      Type.Literal("weakness"),
    ]),
    label: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false }
);

const ScaFindingGraphEdgeV1Schema = Type.Object(
  {
    from_node_id: Type.String({ minLength: 1, maxLength: 512 }),
    to_node_id: Type.String({ minLength: 1, maxLength: 512 }),
    relation: Type.Union([
      Type.Literal("derived_from"),
      Type.Literal("located_in"),
      Type.Literal("classified_as"),
    ]),
  },
  { additionalProperties: false }
);

const ScaControlCoverageV1Schema = Type.Object(
  {
    control_id: Type.Union([
      Type.Literal("source_inventory"),
      Type.Literal("syntax_parsing"),
      Type.Literal("static_rules"),
      Type.Literal("secret_scanning"),
      Type.Literal("dependency_inventory"),
      Type.Literal("advisory_lookup"),
      Type.Literal("deep_source_analysis"),
      Type.Literal("independent_review"),
    ]),
    status: Type.Union([
      Type.Literal("complete"),
      Type.Literal("partial"),
      Type.Literal("missing"),
    ]),
    evidence_ids: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
      maxItems: MAX_ITEMS,
    }),
  },
  { additionalProperties: false }
);

export const ScaFindingSetV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_FINDING_SET_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    m1_manifest_sha256: Sha256Schema,
    m2_manifest_sha256: Sha256Schema,
    status: Type.Union([Type.Literal("derived"), Type.Literal("blocked")]),
    findings: Type.Array(ScaFindingV1Schema, { maxItems: MAX_ITEMS }),
    candidate_dispositions: Type.Array(ScaCandidateDispositionV1Schema, {
      maxItems: MAX_ITEMS,
    }),
    unresolved_candidate_ids: Type.Array(OpaqueIdSchema, { maxItems: MAX_ITEMS }),
    graph_nodes: Type.Array(ScaFindingGraphNodeV1Schema, { maxItems: MAX_ITEMS }),
    graph_edges: Type.Array(ScaFindingGraphEdgeV1Schema, { maxItems: MAX_ITEMS }),
    control_coverage: Type.Array(ScaControlCoverageV1Schema, { minItems: 8, maxItems: 8 }),
    finding_set_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export type ScaFindingDerivationInputV1 = Static<typeof ScaFindingDerivationInputV1Schema>;
export type ScaFindingSetV1 = Static<typeof ScaFindingSetV1Schema>;
type Finding = ScaFindingSetV1["findings"][number];
type UnsignedFinding = Omit<Finding, "finding_sha256">;
type UnsignedFindingSet = Omit<ScaFindingSetV1, "finding_set_sha256">;
type Verdict = ScaCandidateAnalysisResultV1["candidate_verdicts"][number];

export class ScaFindingDerivationError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "binding_mismatch"
      | "m2_not_passed"
      | "missing_support"
      | "finding_digest_mismatch"
      | "finding_set_digest_mismatch",
    message: string
  ) {
    super(message);
    this.name = "ScaFindingDerivationError";
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function findingDigest(value: UnsignedFinding): string {
  return sha256(canonicalJson(value));
}

function findingSetDigest(value: UnsignedFindingSet): string {
  return sha256(canonicalJson(value));
}

function candidateVerdicts(
  candidateId: string,
  analyses: readonly ScaCandidateAnalysisResultV1[]
): readonly { profile_id: ScaCandidateAnalysisResultV1["profile_id"]; verdict: Verdict }[] {
  const results: { profile_id: ScaCandidateAnalysisResultV1["profile_id"]; verdict: Verdict }[] =
    [];
  for (const analysis of analyses) {
    const direct = analysis.candidate_verdicts.find(
      (verdict) => verdict.candidate_id === candidateId
    );
    if (direct !== undefined) results.push({ profile_id: analysis.profile_id, verdict: direct });
    for (const assessment of analysis.file_assessments) {
      const discovered = assessment.discovered_candidates.find(
        (candidate) => candidate.candidate_id === candidateId
      );
      if (discovered !== undefined) {
        results.push({ profile_id: analysis.profile_id, verdict: discovered });
      }
    }
  }
  return results;
}

function weaknessFor(
  candidateId: string,
  m1: ScaM1ManifestV1,
  verdicts: readonly { verdict: Verdict }[]
): string | null {
  const staticObservation = m1.observations.find(
    (observation) => observation.observation_id === candidateId
  );
  if (staticObservation !== undefined) return staticObservation.weakness_id;
  for (const item of verdicts) {
    if ("weakness_id" in item.verdict && typeof item.verdict.weakness_id === "string") {
      return item.verdict.weakness_id;
    }
  }
  return null;
}

function confidenceFor(verdicts: readonly Verdict[]): Finding["confidence"] {
  const counts = new Map<string, number>();
  for (const verdict of verdicts) {
    counts.set(verdict.confidence, (counts.get(verdict.confidence) ?? 0) + 1);
  }
  if ((counts.get("high") ?? 0) >= 2) return "high";
  if ((counts.get("medium") ?? 0) >= 2) return "medium";
  return "low";
}

function evidenceFor(
  verdicts: readonly { profile_id: ScaCandidateAnalysisResultV1["profile_id"]; verdict: Verdict }[]
): Finding["evidence"] {
  const evidence = new Map<string, Finding["evidence"][number]>();
  for (const item of verdicts) {
    for (const claim of item.verdict.evidence) {
      const key = canonicalJson({
        path: claim.path,
        start_line: claim.start_line,
        end_line: claim.end_line,
        evidence_sha256: claim.evidence_sha256,
        claim: claim.claim,
      });
      const existing = evidence.get(key);
      evidence.set(key, {
        ...claim,
        supporting_profiles: [
          ...new Set([...(existing?.supporting_profiles ?? []), item.profile_id]),
        ].sort(compareUtf8),
      });
    }
  }
  return [...evidence.values()].sort((left, right) =>
    compareUtf8(
      `${left.path}\u0000${String(left.start_line).padStart(16, "0")}\u0000${left.evidence_sha256}`,
      `${right.path}\u0000${String(right.start_line).padStart(16, "0")}\u0000${right.evidence_sha256}`
    )
  );
}

function preferredVerdict(
  verdicts: readonly { profile_id: ScaCandidateAnalysisResultV1["profile_id"]; verdict: Verdict }[]
): Verdict {
  const critic = verdicts.find((item) => item.profile_id === "critic");
  const selected =
    critic ??
    [...verdicts].sort((left, right) => compareUtf8(left.profile_id, right.profile_id))[0];
  if (selected === undefined) {
    throw new ScaFindingDerivationError(
      "missing_support",
      "Confirmed candidate has no analysis support"
    );
  }
  return selected.verdict;
}

function controlCoverage(
  m1: ScaM1ManifestV1,
  m2: ScaM2ManifestV1
): ScaFindingSetV1["control_coverage"] {
  const idsFor = (kinds: readonly string[]) =>
    m1.analyzers
      .filter((analyzer) => kinds.includes(analyzer.analyzer_kind))
      .map((analyzer) => analyzer.analyzer_id)
      .sort(compareUtf8);
  const statusFor = (kinds: readonly string[]): "complete" | "partial" | "missing" => {
    const analyzers = m1.analyzers.filter((analyzer) => kinds.includes(analyzer.analyzer_kind));
    if (analyzers.length === 0) return "missing";
    return analyzers.every((analyzer) => analyzer.status === "succeeded") ? "complete" : "partial";
  };
  return [
    {
      control_id: "source_inventory",
      status: statusFor(["source_census"]),
      evidence_ids: idsFor(["source_census"]),
    },
    {
      control_id: "syntax_parsing",
      status: statusFor(["syntax_inventory"]),
      evidence_ids: idsFor(["syntax_inventory"]),
    },
    {
      control_id: "static_rules",
      status: statusFor(["semgrep", "codeql"]),
      evidence_ids: idsFor(["semgrep", "codeql"]),
    },
    {
      control_id: "secret_scanning",
      status: statusFor(["secret_scanner"]),
      evidence_ids: idsFor(["secret_scanner"]),
    },
    {
      control_id: "dependency_inventory",
      status: statusFor(["dependency_inventory"]),
      evidence_ids: idsFor(["dependency_inventory"]),
    },
    { control_id: "advisory_lookup", status: statusFor(["osv"]), evidence_ids: idsFor(["osv"]) },
    {
      control_id: "deep_source_analysis",
      status: m2.file_coverage.every((entry) => entry.status === "complete")
        ? "complete"
        : "partial",
      evidence_ids: m2.file_coverage.map((entry) => entry.path),
    },
    {
      control_id: "independent_review",
      status: m2.status === "passed" ? "complete" : "partial",
      evidence_ids: m2.model_lineage.map((entry) => entry.profile_id),
    },
  ];
}

export function deriveScaFindingSetV1(value: unknown): ScaFindingSetV1 {
  let input: ScaFindingDerivationInputV1;
  try {
    input = validateContract(
      ScaFindingDerivationInputV1Schema,
      value,
      "SCA finding derivation input"
    );
  } catch (error) {
    throw new ScaFindingDerivationError(
      "invalid_input",
      error instanceof Error ? error.message : "SCA finding derivation input is invalid"
    );
  }
  const m1 = validateScaM1ManifestV1(input.m1_manifest);
  const m2 = validateScaM2ManifestV1(input.m2_manifest);
  const analyses = input.analyses.map((analysis) => validateScaCandidateAnalysisResultV1(analysis));
  if (
    m2.tenant_id !== m1.tenant_id ||
    m2.project_id !== m1.project_id ||
    m2.run_id !== m1.run_id ||
    m2.source_snapshot_sha256 !== m1.source_snapshot_sha256 ||
    m2.m1_manifest_sha256 !== m1.manifest_sha256 ||
    analyses.some(
      (analysis) =>
        analysis.run_id !== m1.run_id ||
        analysis.source_snapshot_sha256 !== m1.source_snapshot_sha256 ||
        analysis.m1_manifest_sha256 !== m1.manifest_sha256 ||
        analysis.plan_sha256 !== m2.plan_sha256
    )
  ) {
    throw new ScaFindingDerivationError("binding_mismatch", "SCA finding inputs differ in binding");
  }
  if (m2.status !== "passed") {
    throw new ScaFindingDerivationError("m2_not_passed", "M2 must pass before finding derivation");
  }

  const findings: Finding[] = [];
  const dispositions: ScaFindingSetV1["candidate_dispositions"] = [];
  const unresolved: string[] = [];
  for (const candidate of m2.candidate_consensus) {
    if (candidate.status !== "provisional" || candidate.consensus === null) {
      unresolved.push(candidate.candidate_id);
      continue;
    }
    let findingId: string | null = null;
    if (candidate.consensus.disposition === "confirmed") {
      const allVerdicts = candidateVerdicts(candidate.candidate_id, analyses);
      const agreeing = allVerdicts.filter((item) =>
        candidate.agreeing_profiles.includes(item.profile_id)
      );
      if (agreeing.length < 2) {
        throw new ScaFindingDerivationError(
          "missing_support",
          "Confirmed candidate lacks two bound supporting analyses"
        );
      }
      const preferred = preferredVerdict(agreeing);
      const evidence = evidenceFor(agreeing);
      if (evidence.length === 0) {
        throw new ScaFindingDerivationError(
          "missing_support",
          "Confirmed candidate lacks source-linked evidence"
        );
      }
      const findingIdentity = {
        source_snapshot_sha256: m1.source_snapshot_sha256,
        candidate_id: candidate.candidate_id,
        weakness_id: weaknessFor(candidate.candidate_id, m1, agreeing),
        severity: candidate.consensus.severity,
        reachability: candidate.consensus.reachability,
      };
      findingId = `scafind_${sha256(canonicalJson(findingIdentity))}`;
      const unsignedFinding: UnsignedFinding = {
        finding_id: findingId,
        candidate_id: candidate.candidate_id,
        title: preferred.title,
        weakness_id: findingIdentity.weakness_id,
        severity: candidate.consensus.severity,
        reachability: candidate.consensus.reachability,
        confidence: confidenceFor(agreeing.map((item) => item.verdict)),
        rationale: preferred.rationale,
        remediation: preferred.remediation,
        evidence,
        analysis_gaps: [...new Set(agreeing.flatMap((item) => item.verdict.gaps))].sort(
          compareUtf8
        ),
        requested_action_count: agreeing.reduce(
          (total, item) => total + item.verdict.requested_actions.length,
          0
        ),
        dissenting_profiles: candidate.dissenting_profiles,
      };
      findings.push({ ...unsignedFinding, finding_sha256: findingDigest(unsignedFinding) });
    } else if (candidate.consensus.disposition === "inconclusive") {
      unresolved.push(candidate.candidate_id);
    }
    dispositions.push({
      candidate_id: candidate.candidate_id,
      disposition: candidate.consensus.disposition,
      severity: candidate.consensus.severity,
      reachability: candidate.consensus.reachability,
      finding_id: findingId,
    });
  }
  const graphNodes = new Map<string, ScaFindingSetV1["graph_nodes"][number]>();
  const graphEdges: ScaFindingSetV1["graph_edges"] = [];
  for (const finding of findings) {
    graphNodes.set(finding.finding_id, {
      node_id: finding.finding_id,
      node_kind: "finding",
      label: finding.title,
    });
    graphNodes.set(finding.candidate_id, {
      node_id: finding.candidate_id,
      node_kind: "candidate",
      label: finding.candidate_id,
    });
    graphEdges.push({
      from_node_id: finding.finding_id,
      to_node_id: finding.candidate_id,
      relation: "derived_from",
    });
    for (const path of new Set(finding.evidence.map((entry) => entry.path))) {
      const nodeId = `file:${path}`;
      graphNodes.set(nodeId, { node_id: nodeId, node_kind: "source_file", label: path });
      graphEdges.push({
        from_node_id: finding.finding_id,
        to_node_id: nodeId,
        relation: "located_in",
      });
    }
    if (finding.weakness_id !== null) {
      const nodeId = `weakness:${finding.weakness_id}`;
      graphNodes.set(nodeId, {
        node_id: nodeId,
        node_kind: "weakness",
        label: finding.weakness_id,
      });
      graphEdges.push({
        from_node_id: finding.finding_id,
        to_node_id: nodeId,
        relation: "classified_as",
      });
    }
  }
  const unsigned: UnsignedFindingSet = {
    schema_id: SCA_FINDING_SET_SCHEMA,
    schema_version: 1,
    tenant_id: m1.tenant_id,
    project_id: m1.project_id,
    run_id: m1.run_id,
    source_snapshot_sha256: m1.source_snapshot_sha256,
    m1_manifest_sha256: m1.manifest_sha256,
    m2_manifest_sha256: m2.manifest_sha256,
    status: "derived",
    findings: findings.sort((left, right) => compareUtf8(left.finding_id, right.finding_id)),
    candidate_dispositions: dispositions.sort((left, right) =>
      compareUtf8(left.candidate_id, right.candidate_id)
    ),
    unresolved_candidate_ids: [...new Set(unresolved)].sort(compareUtf8),
    graph_nodes: [...graphNodes.values()].sort((left, right) =>
      compareUtf8(left.node_id, right.node_id)
    ),
    graph_edges: graphEdges.sort((left, right) =>
      compareUtf8(
        `${left.from_node_id}\u0000${left.relation}\u0000${left.to_node_id}`,
        `${right.from_node_id}\u0000${right.relation}\u0000${right.to_node_id}`
      )
    ),
    control_coverage: controlCoverage(m1, m2),
  };
  return validateContract(
    ScaFindingSetV1Schema,
    { ...unsigned, finding_set_sha256: findingSetDigest(unsigned) },
    "SCA finding set"
  );
}

export function validateScaFindingSetV1(value: unknown): ScaFindingSetV1 {
  const findingSet = validateContract(ScaFindingSetV1Schema, value, "SCA finding set");
  for (const finding of findingSet.findings) {
    const { finding_sha256: observedFindingDigest, ...unsignedFinding } = finding;
    if (findingDigest(unsignedFinding) !== observedFindingDigest) {
      throw new ScaFindingDerivationError("finding_digest_mismatch", "SCA finding digest mismatch");
    }
  }
  const { finding_set_sha256: observedDigest, ...unsigned } = findingSet;
  if (findingSetDigest(unsigned) !== observedDigest) {
    throw new ScaFindingDerivationError(
      "finding_set_digest_mismatch",
      "SCA finding-set digest mismatch"
    );
  }
  return findingSet;
}
