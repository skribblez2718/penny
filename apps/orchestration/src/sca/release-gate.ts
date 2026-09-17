import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract } from "../contracts.js";
import { OpaqueIdSchema, Rfc3339UtcSchema, Sha256Schema } from "../skill-contracts/common.js";
import {
  ScaM3ManifestV1Schema,
  validateScaM3ManifestV1,
  type ScaM3ManifestV1,
} from "./finding-validation.js";
import {
  ScaFindingSetV1Schema,
  validateScaFindingSetV1,
  type ScaFindingSetV1,
} from "./findings.js";
import { ScaM2ManifestV1Schema, validateScaM2ManifestV1 } from "./m2-proof-gate.js";
import { ScaM1ManifestV1Schema, validateScaM1ManifestV1 } from "./static-normalization.js";
import {
  ScaM4ManifestV1Schema,
  validateScaM4ManifestV1,
  type ScaM4ManifestV1,
} from "./stronger-evidence.js";

const MAX_ITEMS = 100_000;
const MAX_TEXT = 8_192;

export const SCA_RELEASE_PACKAGE_INPUT_SCHEMA = "penny.sca-release-package-input.v1";
export const SCA_RELEASE_PACKAGE_SCHEMA = "penny.sca-release-package.v1";
export const SCA_RELEASE_DECISION_SCHEMA = "penny.sca-release-decision.v1";
export const SCA_M5_PROOF_INPUT_SCHEMA = "penny.sca-m5-proof-input.v1";
export const SCA_M5_MANIFEST_SCHEMA = "penny.sca-m5-manifest.v1";

const SeveritySchema = Type.Union([
  Type.Literal("critical"),
  Type.Literal("high"),
  Type.Literal("medium"),
  Type.Literal("low"),
  Type.Literal("informational"),
  Type.Literal("unknown"),
]);

const ReleaseBlockerSchema = Type.Object(
  {
    code: Type.Union([
      Type.Literal("m1_not_passed"),
      Type.Literal("m2_not_passed"),
      Type.Literal("m3_not_passed"),
      Type.Literal("m4_not_passed"),
      Type.Literal("upstream_binding_mismatch"),
      Type.Literal("package_binding_mismatch"),
      Type.Literal("missing_human_decision"),
      Type.Literal("release_not_approved"),
      Type.Literal("residual_risk_not_accepted"),
    ]),
    subject_id: Type.String({ minLength: 1, maxLength: 512 }),
    detail: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
  },
  { additionalProperties: false }
);

const RemediationBacklogItemSchema = Type.Object(
  {
    backlog_id: Type.String({ pattern: "^scabacklog_[a-f0-9]{64}$" }),
    finding_id: Type.String({ pattern: "^scafind_[a-f0-9]{64}$" }),
    severity: SeveritySchema,
    title: Type.String({ minLength: 1, maxLength: 512 }),
    remediation: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    status: Type.Literal("open"),
  },
  { additionalProperties: false }
);

const ResidualRiskSchema = Type.Object(
  {
    risk_id: Type.String({ pattern: "^scarisk_[a-f0-9]{64}$" }),
    gap_id: Type.String({ pattern: "^scagap_[a-f0-9]{64}$" }),
    subject_id: Type.String({ minLength: 1, maxLength: 512 }),
    rationale: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    acceptance_required: Type.Literal(true),
  },
  { additionalProperties: false }
);

const AnalysisClosureSchema = Type.Object(
  {
    gap_id: Type.String({ pattern: "^scagap_[a-f0-9]{64}$" }),
    subject_id: Type.String({ minLength: 1, maxLength: 512 }),
    closure: Type.Union([
      Type.Literal("resolved_at_m3"),
      Type.Literal("resolved_at_m4"),
      Type.Literal("accepted_residual_risk"),
      Type.Literal("open"),
    ]),
    evidence_sha256: Type.Union([Sha256Schema, Type.Null()]),
  },
  { additionalProperties: false }
);

const MachineFindingSchema = Type.Object(
  {
    finding_id: Type.String({ pattern: "^scafind_[a-f0-9]{64}$" }),
    title: Type.String({ minLength: 1, maxLength: 512 }),
    weakness_id: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
    severity: SeveritySchema,
    reachability: Type.Union([
      Type.Literal("reachable"),
      Type.Literal("unreachable"),
      Type.Literal("unknown"),
    ]),
    confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    evidence_sha256s: Type.Array(Sha256Schema, { minItems: 1, maxItems: MAX_ITEMS }),
    finding_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const ScaReleasePackageInputV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_RELEASE_PACKAGE_INPUT_SCHEMA),
    schema_version: Type.Literal(1),
    finding_set: ScaFindingSetV1Schema,
    m3_manifest: ScaM3ManifestV1Schema,
    m4_manifest: ScaM4ManifestV1Schema,
  },
  { additionalProperties: false }
);

export const ScaReleasePackageV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_RELEASE_PACKAGE_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    finding_set_sha256: Sha256Schema,
    m3_manifest_sha256: Sha256Schema,
    m4_manifest_sha256: Sha256Schema,
    machine_report: Type.Object(
      {
        finding_count: Type.Integer({ minimum: 0, maximum: MAX_ITEMS }),
        severity_counts: Type.Object(
          {
            critical: Type.Integer({ minimum: 0, maximum: MAX_ITEMS }),
            high: Type.Integer({ minimum: 0, maximum: MAX_ITEMS }),
            medium: Type.Integer({ minimum: 0, maximum: MAX_ITEMS }),
            low: Type.Integer({ minimum: 0, maximum: MAX_ITEMS }),
            informational: Type.Integer({ minimum: 0, maximum: MAX_ITEMS }),
            unknown: Type.Integer({ minimum: 0, maximum: MAX_ITEMS }),
          },
          { additionalProperties: false }
        ),
        findings: Type.Array(MachineFindingSchema, { maxItems: MAX_ITEMS }),
        control_coverage: ScaFindingSetV1Schema.properties.control_coverage,
        stronger_evidence_sha256s: Type.Array(Sha256Schema, { maxItems: MAX_ITEMS }),
      },
      { additionalProperties: false }
    ),
    remediation_backlog: Type.Array(RemediationBacklogItemSchema, { maxItems: MAX_ITEMS }),
    residual_risks: Type.Array(ResidualRiskSchema, { maxItems: MAX_ITEMS }),
    analysis_closure: Type.Array(AnalysisClosureSchema, { maxItems: MAX_ITEMS }),
    executive_summary: Type.String({ minLength: 1, maxLength: 32_768 }),
    blocker_count: Type.Integer({ minimum: 0, maximum: MAX_ITEMS }),
    package_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const ScaReleaseDecisionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_RELEASE_DECISION_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    release_package_sha256: Sha256Schema,
    decision: Type.Union([Type.Literal("approved"), Type.Literal("rejected")]),
    human_principal_id: OpaqueIdSchema,
    authority_receipt_sha256: Sha256Schema,
    accepted_risk_ids: Type.Array(Type.String({ pattern: "^scarisk_[a-f0-9]{64}$" }), {
      maxItems: MAX_ITEMS,
    }),
    rationale: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    decided_at: Rfc3339UtcSchema,
    decision_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const ScaM5ProofInputV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_M5_PROOF_INPUT_SCHEMA),
    schema_version: Type.Literal(1),
    m1_manifest: ScaM1ManifestV1Schema,
    m2_manifest: ScaM2ManifestV1Schema,
    finding_set: ScaFindingSetV1Schema,
    m3_manifest: ScaM3ManifestV1Schema,
    m4_manifest: ScaM4ManifestV1Schema,
    release_package: ScaReleasePackageV1Schema,
    release_decision: Type.Union([ScaReleaseDecisionV1Schema, Type.Null()]),
  },
  { additionalProperties: false }
);

export const ScaM5ManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_M5_MANIFEST_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    m1_manifest_sha256: Sha256Schema,
    m2_manifest_sha256: Sha256Schema,
    finding_set_sha256: Sha256Schema,
    m3_manifest_sha256: Sha256Schema,
    m4_manifest_sha256: Sha256Schema,
    release_package_sha256: Sha256Schema,
    release_decision_sha256: Type.Union([Sha256Schema, Type.Null()]),
    milestone: Type.Literal("M5_RELEASE"),
    status: Type.Union([Type.Literal("released"), Type.Literal("blocked")]),
    release_eligible: Type.Boolean(),
    human_approved: Type.Boolean(),
    accepted_risk_ids: Type.Array(Type.String({ pattern: "^scarisk_[a-f0-9]{64}$" }), {
      maxItems: MAX_ITEMS,
    }),
    blockers: Type.Array(ReleaseBlockerSchema, { maxItems: MAX_ITEMS }),
    manifest_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export type ScaReleasePackageV1 = Static<typeof ScaReleasePackageV1Schema>;
export type ScaReleaseDecisionV1 = Static<typeof ScaReleaseDecisionV1Schema>;
export type ScaM5ManifestV1 = Static<typeof ScaM5ManifestV1Schema>;
type UnsignedPackage = Omit<ScaReleasePackageV1, "package_sha256">;
type UnsignedDecision = Omit<ScaReleaseDecisionV1, "decision_sha256">;
type UnsignedM5 = Omit<ScaM5ManifestV1, "manifest_sha256">;
type ReleaseBlocker = ScaM5ManifestV1["blockers"][number];

export class ScaReleaseGateError extends Error {
  constructor(
    readonly code:
      | "invalid_package_input"
      | "package_digest_mismatch"
      | "invalid_decision"
      | "decision_digest_mismatch"
      | "invalid_m5_input"
      | "m5_manifest_digest_mismatch",
    message: string
  ) {
    super(message);
    this.name = "ScaReleaseGateError";
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function packageDigest(value: UnsignedPackage): string {
  return sha256(canonicalJson(value));
}

function decisionDigest(value: UnsignedDecision): string {
  return sha256(canonicalJson(value));
}

function m5Digest(value: UnsignedM5): string {
  return sha256(canonicalJson(value));
}

function exactReportBinding(
  findingSet: ScaFindingSetV1,
  m3: ScaM3ManifestV1,
  m4: ScaM4ManifestV1
): boolean {
  return (
    findingSet.tenant_id === m3.tenant_id &&
    findingSet.tenant_id === m4.tenant_id &&
    findingSet.project_id === m3.project_id &&
    findingSet.project_id === m4.project_id &&
    findingSet.run_id === m3.run_id &&
    findingSet.run_id === m4.run_id &&
    findingSet.source_snapshot_sha256 === m3.source_snapshot_sha256 &&
    findingSet.source_snapshot_sha256 === m4.source_snapshot_sha256 &&
    findingSet.finding_set_sha256 === m3.finding_set_sha256 &&
    findingSet.finding_set_sha256 === m4.finding_set_sha256 &&
    m3.manifest_sha256 === m4.m3_manifest_sha256
  );
}

function severityCounts(
  findings: ScaFindingSetV1["findings"]
): ScaReleasePackageV1["machine_report"]["severity_counts"] {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, informational: 0, unknown: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function riskId(gapId: string): string {
  return `scarisk_${sha256(canonicalJson({ gap_id: gapId }))}`;
}

function executiveSummary(
  findingSet: ScaFindingSetV1,
  m3: ScaM3ManifestV1,
  m4: ScaM4ManifestV1
): string {
  const counts = severityCounts(findingSet.findings);
  const headline = `${findingSet.findings.length} validated finding${findingSet.findings.length === 1 ? "" : "s"}`;
  return [
    `The source-composition analysis produced ${headline} for snapshot ${findingSet.source_snapshot_sha256}.`,
    `Severity distribution: ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.informational} informational, and ${counts.unknown} unknown.`,
    `${m3.accepted_limitation_count} analysis limitation${m3.accepted_limitation_count === 1 ? "" : "s"} require explicit residual-risk acceptance.`,
    `${m4.resolved_gap_ids.length} stronger-evidence gap${m4.resolved_gap_ids.length === 1 ? " was" : "s were"} resolved.`,
    "Findings remain remediation work items; release of this report does not assert that the analyzed software is vulnerability-free.",
  ].join(" ");
}

export function buildScaReleasePackageV1(value: unknown): ScaReleasePackageV1 {
  let input: Static<typeof ScaReleasePackageInputV1Schema>;
  try {
    input = validateContract(ScaReleasePackageInputV1Schema, value, "SCA release package input");
  } catch (error) {
    throw new ScaReleaseGateError(
      "invalid_package_input",
      error instanceof Error ? error.message : "SCA release package input is invalid"
    );
  }
  const findingSet = validateScaFindingSetV1(input.finding_set);
  const m3 = validateScaM3ManifestV1(input.m3_manifest);
  const m4 = validateScaM4ManifestV1(input.m4_manifest);
  if (!exactReportBinding(findingSet, m3, m4)) {
    throw new ScaReleaseGateError(
      "invalid_package_input",
      "SCA release package inputs have different bindings"
    );
  }
  const remediationBacklog = findingSet.findings.map((finding) => ({
    backlog_id: `scabacklog_${sha256(canonicalJson({ finding_id: finding.finding_id }))}`,
    finding_id: finding.finding_id,
    severity: finding.severity,
    title: finding.title,
    remediation: finding.remediation,
    status: "open" as const,
  }));
  const residualRisks = m3.gap_dispositions
    .filter((gap) => gap.disposition === "accepted_limitation")
    .map((gap) => ({
      risk_id: riskId(gap.gap_id),
      gap_id: gap.gap_id,
      subject_id: gap.subject_id,
      rationale: gap.rationale,
      acceptance_required: true as const,
    }));
  const analysisClosure = m3.gap_dispositions.map((gap) => ({
    gap_id: gap.gap_id,
    subject_id: gap.subject_id,
    closure:
      gap.disposition === "resolved"
        ? ("resolved_at_m3" as const)
        : gap.disposition === "accepted_limitation"
          ? ("accepted_residual_risk" as const)
          : m4.resolved_gap_ids.includes(gap.gap_id)
            ? ("resolved_at_m4" as const)
            : ("open" as const),
    evidence_sha256:
      gap.evidence_sha256 ??
      m4.evidence.find((entry) => entry.gap_ids.includes(gap.gap_id))?.evidence_sha256 ??
      null,
  }));
  const unsigned: UnsignedPackage = {
    schema_id: SCA_RELEASE_PACKAGE_SCHEMA,
    schema_version: 1,
    tenant_id: findingSet.tenant_id,
    project_id: findingSet.project_id,
    run_id: findingSet.run_id,
    source_snapshot_sha256: findingSet.source_snapshot_sha256,
    finding_set_sha256: findingSet.finding_set_sha256,
    m3_manifest_sha256: m3.manifest_sha256,
    m4_manifest_sha256: m4.manifest_sha256,
    machine_report: {
      finding_count: findingSet.findings.length,
      severity_counts: severityCounts(findingSet.findings),
      findings: findingSet.findings.map((finding) => ({
        finding_id: finding.finding_id,
        title: finding.title,
        weakness_id: finding.weakness_id,
        severity: finding.severity,
        reachability: finding.reachability,
        confidence: finding.confidence,
        evidence_sha256s: finding.evidence.map((entry) => entry.evidence_sha256).sort(compareUtf8),
        finding_sha256: finding.finding_sha256,
      })),
      control_coverage: findingSet.control_coverage,
      stronger_evidence_sha256s: m4.evidence
        .map((entry) => entry.evidence_sha256)
        .sort(compareUtf8),
    },
    remediation_backlog: remediationBacklog.sort((left, right) =>
      compareUtf8(left.backlog_id, right.backlog_id)
    ),
    residual_risks: residualRisks.sort((left, right) => compareUtf8(left.risk_id, right.risk_id)),
    analysis_closure: analysisClosure.sort((left, right) => compareUtf8(left.gap_id, right.gap_id)),
    executive_summary: executiveSummary(findingSet, m3, m4),
    blocker_count:
      m3.blockers.length +
      m4.blockers.length +
      analysisClosure.filter((entry) => entry.closure === "open").length,
  };
  return validateContract(
    ScaReleasePackageV1Schema,
    { ...unsigned, package_sha256: packageDigest(unsigned) },
    "SCA release package"
  );
}

export function validateScaReleasePackageV1(value: unknown): ScaReleasePackageV1 {
  const releasePackage = validateContract(ScaReleasePackageV1Schema, value, "SCA release package");
  const { package_sha256: observedDigest, ...unsigned } = releasePackage;
  if (packageDigest(unsigned) !== observedDigest) {
    throw new ScaReleaseGateError("package_digest_mismatch", "SCA release package digest mismatch");
  }
  return releasePackage;
}

export function sealScaReleaseDecisionV1(value: UnsignedDecision): ScaReleaseDecisionV1 {
  let input: UnsignedDecision;
  try {
    input = validateContract(
      Type.Omit(ScaReleaseDecisionV1Schema, ["decision_sha256"]),
      value,
      "SCA release decision input"
    );
  } catch (error) {
    throw new ScaReleaseGateError(
      "invalid_decision",
      error instanceof Error ? error.message : "SCA release decision is invalid"
    );
  }
  if (new Set(input.accepted_risk_ids).size !== input.accepted_risk_ids.length) {
    throw new ScaReleaseGateError("invalid_decision", "Accepted residual-risk IDs must be unique");
  }
  const normalized = {
    ...input,
    accepted_risk_ids: [...input.accepted_risk_ids].sort(compareUtf8),
  };
  return validateContract(
    ScaReleaseDecisionV1Schema,
    { ...normalized, decision_sha256: decisionDigest(normalized) },
    "SCA release decision"
  );
}

export function validateScaReleaseDecisionV1(value: unknown): ScaReleaseDecisionV1 {
  const decision = validateContract(ScaReleaseDecisionV1Schema, value, "SCA release decision");
  const { decision_sha256: observedDigest, ...unsigned } = decision;
  if (decisionDigest(unsigned) !== observedDigest) {
    throw new ScaReleaseGateError(
      "decision_digest_mismatch",
      "SCA release decision digest mismatch"
    );
  }
  return decision;
}

function addBlocker(
  blockers: ReleaseBlocker[],
  code: ReleaseBlocker["code"],
  subjectId: string,
  detail: string
): void {
  blockers.push({ code, subject_id: subjectId, detail });
}

export function buildScaM5ManifestV1(value: unknown): ScaM5ManifestV1 {
  let input: Static<typeof ScaM5ProofInputV1Schema>;
  try {
    input = validateContract(ScaM5ProofInputV1Schema, value, "SCA M5 proof input");
  } catch (error) {
    throw new ScaReleaseGateError(
      "invalid_m5_input",
      error instanceof Error ? error.message : "SCA M5 proof input is invalid"
    );
  }
  const m1 = validateScaM1ManifestV1(input.m1_manifest);
  const m2 = validateScaM2ManifestV1(input.m2_manifest);
  const findingSet = validateScaFindingSetV1(input.finding_set);
  const m3 = validateScaM3ManifestV1(input.m3_manifest);
  const m4 = validateScaM4ManifestV1(input.m4_manifest);
  const releasePackage = validateScaReleasePackageV1(input.release_package);
  const decision =
    input.release_decision === null ? null : validateScaReleaseDecisionV1(input.release_decision);
  const blockers: ReleaseBlocker[] = [];
  if (m1.status !== "passed")
    addBlocker(blockers, "m1_not_passed", m1.manifest_sha256, "M1 blocked");
  if (m2.status !== "passed")
    addBlocker(blockers, "m2_not_passed", m2.manifest_sha256, "M2 blocked");
  if (m3.status !== "passed")
    addBlocker(blockers, "m3_not_passed", m3.manifest_sha256, "M3 blocked");
  if (m4.status !== "passed")
    addBlocker(blockers, "m4_not_passed", m4.manifest_sha256, "M4 blocked");
  const upstreamBound =
    m1.tenant_id === findingSet.tenant_id &&
    m1.project_id === findingSet.project_id &&
    m1.run_id === findingSet.run_id &&
    m1.source_snapshot_sha256 === findingSet.source_snapshot_sha256 &&
    m2.m1_manifest_sha256 === m1.manifest_sha256 &&
    m2.manifest_sha256 === findingSet.m2_manifest_sha256 &&
    findingSet.m1_manifest_sha256 === m1.manifest_sha256 &&
    exactReportBinding(findingSet, m3, m4);
  if (!upstreamBound) {
    addBlocker(
      blockers,
      "upstream_binding_mismatch",
      findingSet.finding_set_sha256,
      "M1-M4 release bindings differ"
    );
  }
  if (
    releasePackage.tenant_id !== findingSet.tenant_id ||
    releasePackage.project_id !== findingSet.project_id ||
    releasePackage.run_id !== findingSet.run_id ||
    releasePackage.source_snapshot_sha256 !== findingSet.source_snapshot_sha256 ||
    releasePackage.finding_set_sha256 !== findingSet.finding_set_sha256 ||
    releasePackage.m3_manifest_sha256 !== m3.manifest_sha256 ||
    releasePackage.m4_manifest_sha256 !== m4.manifest_sha256 ||
    releasePackage.blocker_count !== 0
  ) {
    addBlocker(
      blockers,
      "package_binding_mismatch",
      releasePackage.package_sha256,
      "Release package differs from the proved analysis or contains open blockers"
    );
  }
  if (decision === null) {
    addBlocker(
      blockers,
      "missing_human_decision",
      releasePackage.package_sha256,
      "A bound human release decision is required"
    );
  } else {
    if (
      decision.tenant_id !== releasePackage.tenant_id ||
      decision.project_id !== releasePackage.project_id ||
      decision.run_id !== releasePackage.run_id ||
      decision.source_snapshot_sha256 !== releasePackage.source_snapshot_sha256 ||
      decision.release_package_sha256 !== releasePackage.package_sha256
    ) {
      addBlocker(
        blockers,
        "package_binding_mismatch",
        decision.decision_sha256,
        "Human decision is not bound to this release package"
      );
    }
    if (decision.decision !== "approved") {
      addBlocker(
        blockers,
        "release_not_approved",
        decision.decision_sha256,
        "Human release decision is not approved"
      );
    }
    const accepted = new Set(decision.accepted_risk_ids);
    const expectedRisks = new Set(releasePackage.residual_risks.map((risk) => risk.risk_id));
    for (const risk of releasePackage.residual_risks) {
      if (!accepted.has(risk.risk_id)) {
        addBlocker(
          blockers,
          "residual_risk_not_accepted",
          risk.risk_id,
          "Residual risk lacks explicit acceptance"
        );
      }
    }
    for (const acceptedRiskId of accepted) {
      if (!expectedRisks.has(acceptedRiskId)) {
        addBlocker(
          blockers,
          "residual_risk_not_accepted",
          acceptedRiskId,
          "Human decision accepts a risk outside this release package"
        );
      }
    }
  }
  const released = blockers.length === 0;
  const unsigned: UnsignedM5 = {
    schema_id: SCA_M5_MANIFEST_SCHEMA,
    schema_version: 1,
    tenant_id: findingSet.tenant_id,
    project_id: findingSet.project_id,
    run_id: findingSet.run_id,
    source_snapshot_sha256: findingSet.source_snapshot_sha256,
    m1_manifest_sha256: m1.manifest_sha256,
    m2_manifest_sha256: m2.manifest_sha256,
    finding_set_sha256: findingSet.finding_set_sha256,
    m3_manifest_sha256: m3.manifest_sha256,
    m4_manifest_sha256: m4.manifest_sha256,
    release_package_sha256: releasePackage.package_sha256,
    release_decision_sha256: decision?.decision_sha256 ?? null,
    milestone: "M5_RELEASE",
    status: released ? "released" : "blocked",
    release_eligible: released,
    human_approved: decision?.decision === "approved",
    accepted_risk_ids: decision?.accepted_risk_ids ?? [],
    blockers,
  };
  return validateContract(
    ScaM5ManifestV1Schema,
    { ...unsigned, manifest_sha256: m5Digest(unsigned) },
    "SCA M5 manifest"
  );
}

export function validateScaM5ManifestV1(value: unknown): ScaM5ManifestV1 {
  const manifest = validateContract(ScaM5ManifestV1Schema, value, "SCA M5 manifest");
  const { manifest_sha256: observedDigest, ...unsigned } = manifest;
  if (m5Digest(unsigned) !== observedDigest) {
    throw new ScaReleaseGateError("m5_manifest_digest_mismatch", "SCA M5 manifest digest mismatch");
  }
  return manifest;
}

export function serializeScaMachineReportV1(releasePackage: ScaReleasePackageV1): string {
  return `${canonicalJson(validateScaReleasePackageV1(releasePackage))}\n`;
}

export function renderScaExecutiveReportMarkdownV1(releasePackage: ScaReleasePackageV1): string {
  const value = validateScaReleasePackageV1(releasePackage);
  const findings =
    value.machine_report.findings.length === 0
      ? "No validated findings were retained."
      : value.machine_report.findings
          .map(
            (finding) =>
              `- **${finding.severity.toUpperCase()} — ${finding.title}** (${finding.finding_id}; ${finding.weakness_id ?? "unclassified"}; reachability: ${finding.reachability})`
          )
          .join("\n");
  const backlog =
    value.remediation_backlog.length === 0
      ? "No remediation backlog items."
      : value.remediation_backlog
          .map((item) => `- **${item.title}:** ${item.remediation}`)
          .join("\n");
  const risks =
    value.residual_risks.length === 0
      ? "No residual analysis limitations require acceptance."
      : value.residual_risks.map((risk) => `- **${risk.risk_id}:** ${risk.rationale}`).join("\n");
  return `# Source-Composition Analysis Report\n\n## Executive summary\n\n${value.executive_summary}\n\n## Validated findings\n\n${findings}\n\n## Remediation backlog\n\n${backlog}\n\n## Residual risks\n\n${risks}\n\n## Provenance\n\n- Source snapshot: \`${value.source_snapshot_sha256}\`\n- Finding set: \`${value.finding_set_sha256}\`\n- M3 proof: \`${value.m3_manifest_sha256}\`\n- M4 proof: \`${value.m4_manifest_sha256}\`\n- Release package: \`${value.package_sha256}\`\n`;
}
