import { canonicalJson, sha256 } from "../canonical-json.js";
import { redactScaP11Sensitive } from "./p11-redaction.js";
import {
  SCA_P11_REPORT_JSON_SCHEMA,
  SCA_P11_REPORT_SARIF_SCHEMA,
  validateScaP11ReportJsonV1,
  validateScaP11ReportSarifV1,
  withP11Digest,
  type ScaP11AcceptedFindingV1,
  type ScaP11LaneV1,
  type ScaP11ReconciliationRowV1,
  type ScaP11ReportJsonV1,
  type ScaP11ReportPolicyV1,
  type ScaP11ReportSarifV1,
  type ScaP11ScoringRecordsV1,
} from "./p11-contracts.js";

/**
 * Deterministic representation projection (`SCA-P11` R04/R05/R16). Markdown, JSON, and SARIF all
 * derive from exactly one accepted finding/disposition set, so cross-representation set equality is
 * structural. Representation-specific omissions (for example a SARIF location whose exact
 * repository-root path is not admitted) are declared and justified, never fabricated.
 */
export interface ScaP11LocationV1 {
  readonly path: string;
  readonly line_start: number;
}

export interface ScaP11RenderInputV1 {
  readonly run_id: string;
  readonly revision: number;
  readonly lane: ScaP11LaneV1;
  readonly status: "complete" | "incomplete";
  readonly source_snapshot_sha256: string;
  readonly rows: readonly ScaP11ReconciliationRowV1[];
  readonly policy: ScaP11ReportPolicyV1;
  readonly scoring: ScaP11ScoringRecordsV1;
  readonly location_by_identity: ReadonlyMap<string, ScaP11LocationV1>;
}

export interface ScaP11RenderResultV1 {
  readonly report_json: ScaP11ReportJsonV1;
  readonly sarif: ScaP11ReportSarifV1;
  readonly markdown: string;
  readonly omitted_location_identities: readonly string[];
  readonly incomplete_finding_ids: readonly string[];
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function scaP11FindingId(identity: string): string {
  return `sca11find_${sha256(canonicalJson({ identity }))}`;
}

function findingMarkdown(finding: ScaP11AcceptedFindingV1): string {
  const severityLine = ((): string => {
    if (finding.exception_shape === "informational") {
      return "Informational (no CVSS — hygiene/hardening observation)";
    }
    if (finding.exception_shape === "unscored_incomplete") {
      return "Unscored — incomplete";
    }
    if (finding.exception_shape === "dismissed_non_vulnerability") {
      return "Not applicable — dismissed non-vulnerability (no CVSS)";
    }
    const score = finding.cvss_score === null ? "" : finding.cvss_score.toFixed(1);
    return `${finding.severity_token} — ${score} (${finding.nomenclature ?? "CVSS-B"})`;
  })();
  const lines = [
    `### ${finding.finding_id} — ${finding.title} (${finding.severity_token})`,
    "",
    `- **Severity:** ${severityLine}`,
  ];
  if (finding.cvss_vector !== null) {
    lines.push(`- **CVSS v4.0 Vector:** \`${finding.cvss_vector}\``);
  }
  if (finding.base_cvss_vector !== null && finding.base_cvss_score !== null) {
    lines.push(
      `- **Base severity/vector:** ${finding.base_severity_token ?? finding.severity_token} — ${finding.base_cvss_score.toFixed(1)} (\`${finding.base_cvss_vector}\`)`
    );
  }
  lines.push(
    `- **Scoring rationale:** ${finding.exception_shape === "scored" || finding.exception_shape === "none_zero" ? "deterministic qualified scorer; see the exact scoring-record reference" : "no numeric score is published for this exception shape"}`
  );
  lines.push(
    `- **CWE:** ${finding.cwe_id === null || finding.cwe_name === null ? "⚠ INCOMPLETE — missing: CWE identifier and name" : `${finding.cwe_id} (${finding.cwe_name})`}`
  );
  lines.push(
    `- **Status:** ${finding.status ?? "⚠ INCOMPLETE — missing: report status"} — ${finding.status_note ?? "missing status note"}`
  );
  lines.push(
    `- **Threat model:** ${finding.threat_model_id ?? "⚠ INCOMPLETE — missing: threat-model cross-reference"}`
  );
  lines.push("", "#### Description", finding.description);
  lines.push("", "#### Steps to Reproduce");
  finding.steps_to_reproduce.forEach((step, index) => lines.push(`${String(index + 1)}. ${step}`));
  lines.push("", "#### Code Analysis");
  finding.code_analysis.forEach((step, index) => lines.push(`${String(index + 1)}. ${step}`));
  lines.push("", "#### Remediation", finding.remediation);
  return lines.join("\n");
}

export function renderScaP11MarkdownV1(report: ScaP11ReportJsonV1): string {
  const value = validateScaP11ReportJsonV1(report);
  const findings =
    value.findings.length === 0
      ? "No reportable findings are retained for this revision."
      : value.findings.map(findingMarkdown).join("\n\n");
  const incomplete =
    value.status === "incomplete"
      ? `\n\n## Incomplete material\n\n${value.missing_sections.map((entry) => `- ${entry}`).join("\n")}\n`
      : "";
  const omissions =
    value.representation_omissions.length === 0
      ? "No representation-specific omissions are declared."
      : value.representation_omissions
          .map(
            (entry) => `- **${entry.representation}:** ${entry.omission} — ${entry.justification}`
          )
          .join("\n");
  return [
    "# SCA Source-Composition Analysis Report",
    "",
    `**Status:** ${value.status === "complete" ? "complete" : "⚠ INCOMPLETE"}`,
    "",
    "## 1. Assessment identity and scope",
    "",
    value.assessment_identity,
    "",
    value.scope_statement,
    "",
    `Exact source snapshot: \`${value.source_snapshot_sha256}\``,
    "",
    "## 2. Executive summary",
    "",
    value.executive_summary,
    "",
    "## 3. Tools, rules, graphs, queries, model, and runtime versions",
    "",
    value.tools_statement,
    "",
    "## 4. Actual coverage, exclusions, and unresolved obligations",
    "",
    value.coverage_statement,
    "",
    "## 5. Reportable findings",
    "",
    findings,
    "",
    "## 6. Candidate/disposition reconciliation",
    "",
    `The reconciliation manifest accounts for ${String(value.finding_count)} reportable findings from one accepted finding/disposition set.`,
    "",
    "## 7. Post-verification rule-learning result",
    "",
    value.rule_learning_statement,
    "",
    "## 8. Cross-finding chains and threat-model mapping",
    "",
    "See each finding's threat-model cross-reference and the reconciliation manifest.",
    "",
    "## 9. Output manifest and representation omissions",
    "",
    omissions,
    incomplete,
    "",
  ].join("\n");
}

export function buildScaP11ReportSarifV1(input: {
  readonly report: ScaP11ReportJsonV1;
  readonly location_by_identity: ReadonlyMap<string, ScaP11LocationV1>;
}): {
  readonly sarif: ScaP11ReportSarifV1;
  readonly omitted_location_identities: readonly string[];
} {
  const report = validateScaP11ReportJsonV1(input.report);
  const ruleIdFor = (finding: ScaP11AcceptedFindingV1): string =>
    `penny.sca-p11/${finding.exception_shape}/${finding.severity_token}`;
  const rules = new Map<string, { id: string; name: string; shortDescription: string }>();
  const omitted: string[] = [];
  const results = report.findings.map((finding) => {
    const ruleId = ruleIdFor(finding);
    if (!rules.has(ruleId)) {
      rules.set(ruleId, {
        id: ruleId,
        name: finding.exception_shape,
        shortDescription: `${finding.severity_token} finding from the accepted finding/disposition set`,
      });
    }
    const location = input.location_by_identity.get(finding.identity);
    if (location === undefined) omitted.push(finding.identity);
    return {
      ruleId,
      level:
        finding.severity_token === "Critical" || finding.severity_token === "High"
          ? ("error" as const)
          : finding.severity_token === "Medium" || finding.severity_token === "Low"
            ? ("warning" as const)
            : ("note" as const),
      message: `${finding.severity_token} (${finding.status ?? "unscored"}) — ${finding.title}`,
      finding_id: finding.finding_id,
      locations:
        location === undefined ? [] : [{ path: location.path, start_line: location.line_start }],
    };
  });
  const sarif = validateScaP11ReportSarifV1(
    withP11Digest(
      {
        schema_id: SCA_P11_REPORT_SARIF_SCHEMA,
        schema_version: 1 as const,
        sarif_schema_version: "2.1.0" as const,
        run_id: report.run_id,
        revision: report.revision,
        driver_name: "penny-sca-p11" as const,
        rules: [...rules.values()].sort((left, right) => compareUtf8(left.id, right.id)),
        results: results.sort((left, right) => compareUtf8(left.finding_id, right.finding_id)),
        result_count: results.length,
      },
      "sarif_sha256"
    )
  );
  return { sarif, omitted_location_identities: [...new Set(omitted)].sort(compareUtf8) };
}

/** Build the one accepted finding/disposition set all three representations derive from. */
export function renderScaP11ReportJsonV1(input: ScaP11RenderInputV1): ScaP11ReportJsonV1 {
  const scoringByIdentity = new Map(
    input.scoring.records.map((record) => [record.target_id, record])
  );
  const policyByIdentity = new Map(input.policy.entries.map((entry) => [entry.identity, entry]));
  const findings: ScaP11AcceptedFindingV1[] = [];
  const redact = redactScaP11Sensitive;
  for (const row of input.rows) {
    if (!row.reportable) continue;
    const identity = row.identity;
    const findingId = scaP11FindingId(identity);
    const scoring = scoringByIdentity.get(identity);
    const entry = policyByIdentity.get(identity);
    const missing: string[] = [];
    if (entry === undefined) {
      missing.push("report content authority entry");
      // CWE identifier and name are mandatory for every per-finding block; no severity case waives
      // the required CWE metadata (report standard §4/§6, `P11-R06`).
      missing.push("CWE identifier and name");
      missing.push("threat-model cross-reference");
    } else {
      if (entry.cwe_id === null || entry.cwe_name === null) {
        missing.push("CWE identifier and name");
      }
      if (entry.threat_model_id === null) missing.push("threat-model cross-reference");
    }
    if (scoring === undefined) missing.push("scoring record");
    const exceptionShape = scoring?.exception_shape ?? "unscored_incomplete";
    const severityToken = scoring?.severity_token ?? "Unscored";
    const missingMaterial = [...new Set([...missing, ...row.missing_material])].sort(compareUtf8);
    const complete = missingMaterial.length === 0 && exceptionShape !== "unscored_incomplete";
    const generatedStatusNote =
      row.report_status === "Confirmed — code verified"
        ? "Code-verified from the exact reconciled evidence; runtime verification was not performed."
        : row.report_status === "False positive"
          ? "Dismissed non-vulnerability; exact mitigating evidence is retained in the reconciliation manifest."
          : row.report_status === "Probable"
            ? "Evidence-consistent but not code-verified; retained as a probable exposure."
            : row.report_status === "Theoretical"
              ? "Deferred evidence; retained as a theoretical exposure only."
              : null;
    const statusNote = entry?.status_note ?? generatedStatusNote;
    findings.push({
      finding_id: findingId,
      identity,
      semantic_only: row.semantic_only,
      title: redact(entry?.title ?? `Reconciled record ${identity}`),
      severity_token: severityToken,
      cvss_score: scoring?.score ?? null,
      cvss_vector: scoring?.score == null ? null : canonicalVectorFor(scoring),
      base_severity_token:
        scoring?.base_score == null ? null : severityTokenForScore(scoring.base_score),
      base_cvss_score: scoring?.base_score ?? null,
      base_cvss_vector:
        scoring?.base_vector === null || scoring?.base_vector === undefined
          ? null
          : scoring.base_vector.join("/"),
      nomenclature: scoring?.nomenclature ?? null,
      cwe_id: entry?.cwe_id ?? null,
      cwe_name: entry?.cwe_name == null ? null : redact(entry.cwe_name),
      status: row.report_status,
      status_note: statusNote === null ? null : redact(statusNote),
      threat_model_id: entry?.threat_model_id ?? null,
      exception_shape: exceptionShape,
      scoring_record_ref: null,
      evidence_refs: [...row.source_refs],
      source_refs: [...row.source_refs],
      description: redact(entry?.description ?? "⚠ INCOMPLETE — missing: description"),
      steps_to_reproduce: (
        entry?.steps_to_reproduce ?? ["NOT RUN — missing: reproduction steps"]
      ).map(redact),
      code_analysis: (entry?.code_analysis ?? ["missing: causal code-analysis walk"]).map(redact),
      remediation: redact(entry?.remediation ?? "missing: application-specific remediation"),
      complete,
      missing_material: complete ? [] : missingMaterial,
    });
  }
  const sorted = [...findings].sort((left, right) =>
    compareUtf8(left.finding_id, right.finding_id)
  );
  const incompleteFindings = sorted.filter((finding) => !finding.complete);
  const missingSections = incompleteFindings.map(
    (finding) => `⚠ INCOMPLETE — missing: ${finding.missing_material.join(", ")}`
  );
  const retainedUnresolved = input.rows.some(
    (row) => !row.reportable && (row.missing_material.length > 0 || row.checkpoint_ref !== null)
  );
  const status: "complete" | "incomplete" =
    input.status === "incomplete" ||
    sorted.length === 0 ||
    incompleteFindings.length > 0 ||
    retainedUnresolved ||
    input.lane === "incomplete_closeout"
      ? "incomplete"
      : "complete";
  return validateScaP11ReportJsonV1(
    withP11Digest(
      {
        schema_id: SCA_P11_REPORT_JSON_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P11" as const,
        run_id: input.run_id,
        revision: input.revision,
        lane: input.lane,
        status,
        source_snapshot_sha256: input.source_snapshot_sha256,
        assessment_identity: redact(input.policy.statements.assessment_identity),
        scope_statement: redact(input.policy.statements.scope_statement),
        coverage_statement: redact(input.policy.statements.coverage_statement),
        rule_learning_statement: redact(input.policy.statements.rule_learning_statement),
        tools_statement: redact(input.policy.statements.tools_statement),
        executive_summary: redact(input.policy.statements.executive_summary),
        findings: sorted,
        finding_count: sorted.length,
        incomplete_finding_count: incompleteFindings.length,
        missing_sections: missingSections,
        representation_omissions: [],
      },
      "report_json_sha256"
    )
  );
}

function canonicalVectorFor(scoring: ScaP11ScoringRecordsV1["records"][number]): string | null {
  if (scoring.metric_vector === null) return null;
  return ["CVSS:4.0", ...scoring.metric_vector].join("/");
}

function severityTokenForScore(score: number) {
  if (score === 0) return "None" as const;
  if (score < 4) return "Low" as const;
  if (score < 7) return "Medium" as const;
  if (score < 9) return "High" as const;
  return "Critical" as const;
}

/** Declare one representation-specific omission with its justification. */
export function withScaP11RepresentationOmission(
  report: ScaP11ReportJsonV1,
  omission: {
    readonly representation: "markdown" | "json" | "sarif";
    readonly omission: string;
    readonly justification: string;
  }
): ScaP11ReportJsonV1 {
  const value = validateScaP11ReportJsonV1(report);
  const { report_json_sha256: _previousDigest, ...body } = value;
  return validateScaP11ReportJsonV1(
    withP11Digest(
      {
        ...body,
        representation_omissions: [...value.representation_omissions, omission].sort(
          (left, right) =>
            compareUtf8(
              `${left.representation}\u0000${left.omission}`,
              `${right.representation}\u0000${right.omission}`
            )
        ),
      },
      "report_json_sha256"
    )
  );
}
