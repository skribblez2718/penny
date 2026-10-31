import {
  SCA_P11_SUPPORTED_REPORT_STATUSES,
  SCA_P11_VALIDATION_RECORDS_SCHEMA,
  validateScaP11ValidationRecordsV1,
  withP11Digest,
  type ScaP11OpenItemDispositionV1,
  type ScaP11ReconciliationV1,
  type ScaP11ReportJsonV1,
  type ScaP11ReportSarifV1,
  type ScaP11ValidationRecordsV1,
} from "./p11-contracts.js";
import { renderScaP11MarkdownV1 } from "./p11-render.js";
import { scaP11HasSensitiveContent } from "./p11-redaction.js";
import type { ArtifactRef } from "../contracts.js";

/**
 * Deterministic validation (`SCA-P11` R12, report standard §10.4). It proves shape, exact equality,
 * section order, path shape, score/vector/nomenclature consistency, and cross-output set equality;
 * it cannot prove narrative truth, which is the separate semantic review's duty. Both must pass.
 */
export interface ScaP11DeterministicCheckV1 {
  readonly check_id: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ScaP11DeterministicInputV1 {
  readonly report: ScaP11ReportJsonV1;
  readonly sarif: ScaP11ReportSarifV1;
  readonly reconciliation: ScaP11ReconciliationV1;
  readonly markdown?: string;
}

function findingMarkdownIds(markdown: string): string[] {
  return [...markdown.matchAll(/^### (sca11find_[a-f0-9]{64}) — /gmu)].map(
    (match) => match[1] ?? ""
  );
}

function isRepositoryPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.startsWith("~") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.split("/").includes("..") &&
    !path.includes("//")
  );
}

/** Absolute host paths and elided fragments that must never appear in a representation. */
const HOST_PATH_PATTERNS: readonly RegExp[] = Object.freeze([
  /(?:^|[^\w.:])\/(?:home|Users|root|etc|var|opt|tmp|mnt|Volumes)\//u,
  /\b[A-Za-z]:\\(?:Users|Windows|Program Files)\\/u,
  /(?:^|\s)~\//mu,
  /\.\.\.\/|\.\.\/\.\.\//u,
]);

const CURL_PREREQUISITE = /(NOT RUN|placeholder|authori[sz]ed|\$[A-Z_]|<[a-z-]+>)/iu;

function hasHostPath(text: string): boolean {
  return HOST_PATH_PATTERNS.some((pattern) => pattern.test(text));
}

/** Every `curl` usage must state its exact prerequisite on the same line; otherwise it is unsafe. */
function unsafeCurlLine(text: string): boolean {
  return text.split("\n").some((line) => /\bcurl\b/u.test(line) && !CURL_PREREQUISITE.test(line));
}

export function validateScaP11Deterministic(
  input: ScaP11DeterministicInputV1
): readonly ScaP11DeterministicCheckV1[] {
  const report = input.report;
  const markdown = input.markdown ?? renderScaP11MarkdownV1(report);
  const checks: ScaP11DeterministicCheckV1[] = [];
  const push = (check_id: string, passed: boolean, detail: string): void => {
    checks.push({ check_id, passed, detail });
  };

  const headerTokens = new Map<string, string>();
  for (const match of markdown.matchAll(/^### (sca11find_[a-f0-9]{64}) — .*\(([^()]*)\)\s*$/gmu)) {
    headerTokens.set(match[1] ?? "", match[2] ?? "");
  }
  push(
    "title_severity_equality",
    report.findings.every(
      (finding) => headerTokens.get(finding.finding_id) === finding.severity_token
    ),
    "every finding title token must case-sensitively equal its Severity metadata token"
  );

  push(
    "five_section_order",
    report.findings.every((finding) => {
      const start = markdown.indexOf(`### ${finding.finding_id} — `);
      if (start < 0) return false;
      const block = markdown.slice(start);
      const end = block.indexOf("\n### ");
      const body = end < 0 ? block : block.slice(0, end);
      const order = [
        "#### Description",
        "#### Steps to Reproduce",
        "#### Code Analysis",
        "#### Remediation",
      ];
      let cursor = -1;
      for (const section of order) {
        const at = body.indexOf(section);
        if (at < 0 || at < cursor) return false;
        cursor = at;
      }
      return true;
    }),
    "every finding must carry exactly the five required sections in order"
  );

  push(
    "cwe_metadata_complete",
    report.findings.every((finding) => finding.cwe_id !== null && finding.cwe_name !== null),
    "every per-finding block must name a defensible CWE identifier and canonical name; no severity case waives it"
  );

  push(
    "threat_model_reference_valid",
    report.findings.every((finding) =>
      finding.threat_model_id === null
        ? !finding.complete
        : /^\{[A-Z0-9_-]{1,96}\}$/u.test(finding.threat_model_id)
    ),
    "every complete finding must carry a well-formed threat-model cross-reference"
  );

  const sarifText = JSON.stringify(input.sarif);
  const redactionClean =
    !scaP11HasSensitiveContent(JSON.stringify(report)) &&
    !scaP11HasSensitiveContent(markdown) &&
    !scaP11HasSensitiveContent(sarifText);
  push(
    "redaction_clean",
    redactionClean,
    "no representation may reproduce a secret or personal-data span; redaction wins in Markdown, JSON, and SARIF"
  );

  push(
    "host_path_absence",
    !hasHostPath(markdown) && !hasHostPath(JSON.stringify(report)) && !hasHostPath(sarifText),
    "no representation may embed an absolute host path or an elided path fragment"
  );

  push(
    "safe_curl_prerequisites",
    !unsafeCurlLine(markdown),
    "every reproduction command must state its exact safe prerequisite rather than assuming execution authority"
  );

  push(
    "status_note_required",
    report.findings.every(
      (finding) =>
        finding.status === null || (finding.status_note !== null && finding.status_note.length > 0)
    ),
    "every presented status must carry its required one-line evidence or gap note"
  );

  const supportedStatuses = new Set<string>(SCA_P11_SUPPORTED_REPORT_STATUSES);
  push(
    "status_mapping_supported",
    report.findings.every(
      (finding) => finding.status === null || supportedStatuses.has(finding.status)
    ),
    "every presented status must be one of the supported deterministic disposition mappings"
  );

  push(
    "zero_findings_incomplete",
    report.findings.length > 0 || report.status === "incomplete",
    "a report with no reportable findings must not be a complete stub success"
  );

  push(
    "score_vector_nomenclature_consistency",
    report.findings.every((finding) => {
      if (finding.exception_shape !== "scored" && finding.exception_shape !== "none_zero") {
        return (
          finding.cvss_score === null &&
          finding.cvss_vector === null &&
          finding.nomenclature === null
        );
      }
      if (
        finding.cvss_score === null ||
        finding.cvss_vector === null ||
        finding.nomenclature === null
      )
        return false;
      if (!finding.cvss_vector.startsWith("CVSS:4.0/")) return false;
      const metrics = finding.cvss_vector.split("/").slice(1);
      const baseOrder = ["AV", "AC", "AT", "PR", "UI", "VC", "VI", "VA", "SC", "SI", "SA"];
      if (
        metrics.length < 11 ||
        metrics
          .slice(0, 11)
          .some((metric, index) => !metric.startsWith(`${baseOrder[index] ?? ""}:`))
      ) {
        return false;
      }
      const hasThreat = finding.cvss_vector.includes("/E:");
      const hasEnvironmental = finding.cvss_vector.includes("/CR:");
      const expected =
        hasThreat && hasEnvironmental
          ? "CVSS-BTE"
          : hasThreat
            ? "CVSS-BT"
            : hasEnvironmental
              ? "CVSS-BE"
              : "CVSS-B";
      return finding.nomenclature === expected;
    }),
    "score, vector, and nomenclature must be mutually consistent with no v3 inference"
  );

  const jsonIds = report.findings.map((finding) => finding.finding_id).sort();
  const sarifIds = input.sarif.results.map((result) => result.finding_id).sort();
  const markdownIds = findingMarkdownIds(markdown).sort();
  const equalSets =
    jsonIds.length === sarifIds.length &&
    jsonIds.length === markdownIds.length &&
    jsonIds.every((id, index) => id === sarifIds[index] && id === markdownIds[index]);
  push(
    "cross_output_set_equality",
    equalSets,
    "Markdown, JSON, and SARIF must carry the same accepted finding set with no silent divergence"
  );

  const reportableRows = input.reconciliation.rows.filter((row) => row.reportable);
  push(
    "no_dropped_finding",
    reportableRows.length === report.findings.length,
    "every reportable reconciled record must appear as a finding"
  );

  push(
    "semantic_only_findings_included",
    input.reconciliation.rows
      .filter((row) => row.semantic_only && row.reportable)
      .every((row) => report.findings.some((finding) => finding.identity === row.identity)),
    "an AI-discovered issue with no scanner JSON record must not be dropped"
  );

  const complete = report.status === "complete";
  push(
    "placeholder_absence",
    !complete || (!markdown.includes("⚠ INCOMPLETE") && !markdown.includes("missing:")),
    "a complete report must contain no stub, placeholder, or incomplete marker"
  );

  const paths = input.sarif.results.flatMap((result) =>
    result.locations.map((location) => location.path)
  );
  push(
    "path_shape",
    paths.every((path) => isRepositoryPath(path)),
    "every source citation must be a complete repository-root path with no host or elided fragment"
  );

  push(
    "reference_validity",
    report.findings.every((finding) =>
      [...finding.evidence_refs, ...finding.source_refs].every((ref) =>
        /^art_[a-f0-9]{64}$/u.test(ref.artifact_id)
      )
    ),
    "every finding reference must be a valid exact artifact identity"
  );

  push(
    "latest_revision_only",
    input.sarif.revision === report.revision,
    "the SARIF projection must bind the same latest revision as the accepted report set"
  );

  return checks;
}

export interface ScaP11BuildValidationInputV1 {
  readonly run_id: string;
  readonly revision: number;
  readonly report_json_ref: ArtifactRef;
  readonly report: ScaP11ReportJsonV1;
  readonly sarif: ScaP11ReportSarifV1;
  readonly reconciliation: ScaP11ReconciliationV1;
  readonly semantic_review_ref: ArtifactRef | null;
  readonly semantic_passed: boolean;
  readonly open_items: readonly {
    readonly open_item_id: string;
    readonly target_id: string;
    readonly severity: "blocking" | "actionable";
    readonly disposition: ScaP11OpenItemDispositionV1;
    readonly evidence_refs: readonly ArtifactRef[];
  }[];
  readonly repair_records: readonly ArtifactRef[];
  readonly missing_material: readonly string[];
}

export function buildScaP11ValidationRecordsV1(
  input: ScaP11BuildValidationInputV1
): ScaP11ValidationRecordsV1 {
  const deterministic = validateScaP11Deterministic({
    report: input.report,
    sarif: input.sarif,
    reconciliation: input.reconciliation,
  });
  const deterministicPassed = deterministic.every((check) => check.passed);
  const missingMaterial = [
    ...new Set([
      ...input.missing_material,
      ...input.report.missing_sections,
      ...deterministic
        .filter((check) => !check.passed)
        .map((check) => `deterministic: ${check.check_id}`),
    ]),
  ].sort();
  const incomplete =
    missingMaterial.length > 0 ||
    input.open_items.some((item) => item.disposition === "retained-incomplete");
  return validateScaP11ValidationRecordsV1(
    withP11Digest(
      {
        schema_id: SCA_P11_VALIDATION_RECORDS_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P11" as const,
        run_id: input.run_id,
        revision: input.revision,
        report_json_ref: input.report_json_ref,
        report_json_sha256: input.report_json_ref.content_digest,
        deterministic_checks: [...deterministic]
          .sort((left, right) => (left.check_id < right.check_id ? -1 : 1))
          .map((check) => ({
            check_id: check.check_id,
            passed: check.passed,
            detail: check.detail,
          })),
        deterministic_passed: deterministicPassed,
        semantic_review_ref: input.semantic_review_ref,
        semantic_passed: input.semantic_passed,
        open_items: input.open_items.map((item) => ({
          open_item_id: item.open_item_id,
          target_id: item.target_id,
          severity: item.severity,
          disposition: item.disposition,
          evidence_refs: [...item.evidence_refs],
        })),
        repair_records: [...input.repair_records],
        incomplete,
        incomplete_marker: incomplete
          ? `⚠ INCOMPLETE — missing: ${missingMaterial.join(", ")}`
          : null,
        missing_material: missingMaterial,
        append_only: true as const,
      },
      "validation_sha256"
    )
  );
}
