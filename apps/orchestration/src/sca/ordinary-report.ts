import {
  ScaAdvancedSummarySchema,
  type ScaAdvancedSummary,
} from "./ordinary-advanced-contracts.js";
import { Type, type Static } from "typebox";
import { version as tsVersion } from "typescript";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import { scoreScaCvssV4 } from "./cvss-v4.js";
import { resolveScaStructuralWitness } from "./active-symbol-resolution.js";
import type { ParsedScaSourceCorpusV1 } from "./active-compliance.js";
import { verifyPointer, assertSetEqual } from "./ordinary-artifacts.js";
import {
  ScaDispositionsSchema,
  ScaHypothesesSchema,
  ScaLearningSchema,
  ScaPreparationSchema,
  ScaSelectionSchema,
  ScaReportDraftSchema,
  type ScaDispositions,
  type ScaHypotheses,
  type ScaLearning,
  type ScaPreparation,
  type ScaReportDraft,
  type ScaSelection,
  type ScaAnalysisTools,
} from "./ordinary-contracts.js";
import type { ScaGraphData } from "./ordinary-host.js";
import { redactScaP11Sensitive, scaP11HasSensitiveContent } from "./p11-redaction.js";

const text = Type.String({ minLength: 1, maxLength: 32_768 });
const gaps = Type.Array(text, { maxItems: 2048 });
const ScoreSchema = Type.Object(
  {
    score: Type.Number({ minimum: 0, maximum: 10 }),
    vector: text,
    nomenclature: Type.Union([
      Type.Literal("CVSS-B"),
      Type.Literal("CVSS-BT"),
      Type.Literal("CVSS-BE"),
      Type.Literal("CVSS-BTE"),
    ]),
    rating: Type.Union([
      Type.Literal("None"),
      Type.Literal("Low"),
      Type.Literal("Medium"),
      Type.Literal("High"),
      Type.Literal("Critical"),
    ]),
    base_score: Type.Number({ minimum: 0, maximum: 10 }),
    base_vector: text,
  },
  { additionalProperties: false }
);
export const ScaAcceptedFindingSchema = Type.Object(
  {
    ...ScaReportDraftSchema.properties.findings.items.properties,
    finding_id: Type.String({ pattern: "^F-[a-f0-9]{24}$" }),
    status: Type.Union([
      Type.Literal("Confirmed — code verified"),
      Type.Literal("Probable"),
      Type.Literal("Theoretical"),
    ]),
    status_note: text,
    threat_id: text,
    severity: Type.Union([
      Type.Literal("None"),
      Type.Literal("Low"),
      Type.Literal("Medium"),
      Type.Literal("High"),
      Type.Literal("Critical"),
      Type.Literal("Unscored"),
    ]),
    scoring: Type.Union([ScoreSchema, Type.Null()]),
    scoring_record_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    missing: gaps,
  },
  { additionalProperties: false }
);
export const ScaReportProductSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-report.v3"),
    schema_version: Type.Literal(1),
    run_id: text,
    source_snapshot_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    scope: Type.Object(
      { include: Type.Array(text), exclude: Type.Array(text) },
      { additionalProperties: false }
    ),
    status: Type.Union([Type.Literal("COMPLETE"), Type.Literal("INCOMPLETE")]),
    executive_summary: text,
    preparation: ScaPreparationSchema,
    graph_observations: Type.Array(
      Type.Object(
        {
          language: text,
          graph_sha256: text,
          frontend_version: text,
          joern_version: Type.Union([text, Type.Null()]),
          queries: Type.Array(
            Type.Object(
              {
                id: text,
                script_sha256: Type.Union([text, Type.Null()]),
                raw_stdout_sha256: text,
                observation_sha256: text,
                complete: Type.Boolean(),
                supported_files: Type.Integer({ minimum: 0 }),
                unsupported_files: Type.Integer({ minimum: 0 }),
              },
              { additionalProperties: false }
            ),
            { maxItems: 16 }
          ),
        },
        { additionalProperties: false }
      ),
      { maxItems: 2 }
    ),
    selections: Type.Array(ScaSelectionSchema, { minItems: 2, maxItems: 2 }),
    hypotheses: ScaHypothesesSchema,
    dispositions: ScaDispositionsSchema,
    learning: ScaLearningSchema,
    findings: Type.Array(ScaAcceptedFindingSchema, { maxItems: 64 }),
    candidates: Type.Array(
      Type.Object(
        {
          id: text,
          decision: Type.Union([Type.Literal("selected"), Type.Literal("deferred")]),
          selection_ids: Type.Array(text),
          hypothesis_ids: Type.Array(text),
          note: text,
        },
        { additionalProperties: false }
      ),
      { maxItems: 512 }
    ),
    coverage: Type.Array(
      Type.Object(
        {
          path: text,
          state: Type.Union([
            Type.Literal("focused"),
            Type.Literal("not_selected"),
            Type.Literal("unsupported"),
          ]),
          reason: text,
        },
        { additionalProperties: false }
      ),
      { maxItems: 100_000 }
    ),
    chains: ScaReportDraftSchema.properties.chains,
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 128 }),
    gaps,
    advanced: Type.Optional(ScaAdvancedSummarySchema),
    reproduction: Type.Union([
      Type.Literal("NOT RUN"),
      Type.Literal("RUN"),
      Type.Literal("UNKNOWN"),
    ]),
    target_executed: Type.Union([Type.Boolean(), Type.Null()]),
    representation_omissions: Type.Array(text, { maxItems: 16 }),
  },
  { additionalProperties: false }
);
export type ScaReportProduct = Static<typeof ScaReportProductSchema>;
const REPORTABLE = new Set(["confirmed_code", "probable", "theoretical", "inconclusive"]);
export function reportableHypotheses(dispositions: ScaDispositions): string[] {
  return dispositions.dispositions
    .filter((entry) => REPORTABLE.has(entry.disposition))
    .map((entry) => entry.hypothesis_id);
}
function sanitize(value: ScaReportProduct, privatePaths: readonly string[]): ScaReportProduct {
  // Runtime revalidation below guarantees the same closed product after string-only redaction.
  const walk = (current: unknown): unknown => {
    // Exact immutable addresses are schema-validated metadata, not prose/credentials.
    if (current === value.evidence_refs) return value.evidence_refs;
    if (typeof current === "string") {
      let result = redactScaP11Sensitive(current);
      for (const selected of privatePaths.filter((entry) => entry.length > 1))
        result = result.replaceAll(selected, "[WITHHELD-HOST-PATH]");
      return result;
    }
    if (Array.isArray(current)) return current.map(walk);
    if (current !== null && typeof current === "object")
      return Object.fromEntries(Object.entries(current).map(([key, entry]) => [key, walk(entry)]));
    return current;
  };
  const redacted = validateContract(ScaReportProductSchema, walk(value), "SCA redacted report");
  if (canonicalJson(redacted) !== canonicalJson(value)) {
    redacted.status = "INCOMPLETE";
    redacted.gaps.push(
      "Sensitive source/report material withheld; public citations or reproduction completeness may be reduced. Exact private evidence remains in access-controlled artifacts, not this report."
    );
    for (let index = 0; index < redacted.findings.length; index += 1) {
      const finding = redacted.findings[index];
      if (
        finding !== undefined &&
        canonicalJson(finding) !== canonicalJson(value.findings[index])
      ) {
        finding.missing.push(
          "Sensitive material withheld; exact public proof/reproduction requires separately authorized private evidence access."
        );
        finding.scoring_record_sha256 = sha256(
          canonicalJson({
            scoring: finding.scoring,
            rationale: finding.scoring_rationale,
            metric_evidence: finding.metric_evidence,
            scorer: "penny:scoreScaCvssV4:FIRST-v4",
          })
        );
      }
    }
  }
  return validateContract(ScaReportProductSchema, redacted, "SCA redacted report");
}
/** Retain stage-time limitations without relabeling them as current missing evidence. */
export function recordedScaGaps(stage: string, values: readonly string[]): string[] {
  return values.map((value) => `Recorded at ${stage}: ${value}`);
}
export function assembleScaReport(input: {
  runId: string;
  scope: ScaReportProduct["scope"];
  corpus: ParsedScaSourceCorpusV1;
  preparation: ScaPreparation;
  selections: readonly ScaSelection[];
  hypotheses: ScaHypotheses;
  dispositions: ScaDispositions;
  learning: ScaLearning;
  advanced?: ScaAdvancedSummary;
  graphs?: readonly ScaGraphData[];
  graphConfig?: ScaAnalysisTools["graph"];
  draft: ScaReportDraft;
  evidenceRefs: readonly ArtifactRef[];
  inheritedGaps: readonly string[];
  privatePaths: readonly string[];
}): ScaReportProduct {
  const reportable = reportableHypotheses(input.dispositions);
  const advanced = input.advanced ?? { schema_version: 1 as const, operations: [] };
  const execution = advanced.operations.some(
    (x) => x.stage === "application" && x.execution === "UNKNOWN"
  )
    ? "UNKNOWN"
    : advanced.operations.some((x) => x.stage === "application" && x.execution === "RUN")
      ? "RUN"
      : "NOT RUN";
  const allGaps = [
    ...advanced.operations
      .filter((x) => x.stage === "rescan" && x.findings_count > 0)
      .map(
        (x) =>
          `${x.selection_id}: ${x.findings_count} unconfirmed rescan leads retained in a new investigation revision; not automatically confirmed.`
      ),
    ...advanced.operations
      .filter(
        (x) =>
          ![
            "completed",
            "validated",
            "promoted",
            "adopted",
            "not_feasible",
            "not_requested",
          ].includes(x.status) ||
          x.quarantine_required ||
          !x.baseline_unchanged
      )
      .map(
        (x) =>
          `${x.stage}/${x.action_id}: ${x.status}; execution ${x.execution}; quarantine=${x.quarantine_required}`
      ),
    ...input.inheritedGaps,
    ...recordedScaGaps("preparing_analysis", input.preparation.gaps),
    ...recordedScaGaps("forming_hypotheses", input.hypotheses.gaps),
    ...recordedScaGaps("reconciling_dispositions", input.dispositions.gaps),
    ...recordedScaGaps("assessing_learning", input.learning.gaps),
    ...recordedScaGaps("materializing_report", input.draft.gaps),
  ];
  for (const cap of input.preparation.capabilities)
    if (cap.status !== "completed") allGaps.push(`${cap.id}: ${cap.status} — ${cap.detail}`);
  for (const entry of input.dispositions.dispositions) {
    allGaps.push(...entry.gaps.map((gap) => `${entry.hypothesis_id}: ${gap}`));
    if (
      entry.disposition === "inconclusive" ||
      entry.disposition === "probable" ||
      entry.disposition === "theoretical"
    )
      allGaps.push(`${entry.hypothesis_id}: unresolved ${entry.disposition} evidence.`);
  }
  assertSetEqual(
    input.draft.findings.map((entry) => entry.hypothesis_id),
    reportable,
    "reportable finding set"
  );
  const findings = input.draft.findings.map((draft): ScaReportProduct["findings"][number] => {
    const hypothesis = input.hypotheses.hypotheses.find(
      (entry) => entry.id === draft.hypothesis_id
    );
    const disposition = input.dispositions.dispositions.find(
      (entry) => entry.hypothesis_id === draft.hypothesis_id
    );
    if (hypothesis === undefined || disposition === undefined)
      throw new Error("SCA report includes a foreign hypothesis");
    const missing = [...draft.reproduction_gaps];
    for (const step of draft.code_analysis) verifyPointer(input.corpus, step.pointer);
    for (const metric of draft.metric_evidence)
      for (const pointer of metric.evidence) verifyPointer(input.corpus, pointer);
    if (draft.cwe_id === null || draft.cwe_name === null)
      missing.push("CWE identifier and canonical name");
    if (draft.code_analysis.length < 2)
      missing.push("complete causal code walk from initiation through security-sensitive outcome");
    if (draft.prerequisites.length === 0 || draft.reproduction.length === 0)
      missing.push("known safe reproduction prerequisites/procedure; target NOT RUN");
    if (draft.regression_tests.length === 0)
      missing.push("specific regression/fixed/negative tests");
    let scoring: ScaReportProduct["findings"][number]["scoring"] = null;
    if (draft.cvss_vector === null || draft.missing_metrics.length > 0)
      missing.push(
        `CVSS Base metrics/evidence: ${draft.missing_metrics.join(", ") || "not supplied"}`
      );
    else {
      const required = draft.cvss_vector
        .split("/")
        .slice(1)
        .filter((part) => !part.endsWith(":X"))
        .map((part) => part.split(":")[0] ?? "");
      try {
        assertSetEqual(
          draft.metric_evidence.map((entry) => entry.metric),
          required,
          "CVSS metric evidence"
        );
        scoring = scoreScaCvssV4(draft.cvss_vector);
      } catch {
        missing.push("valid CVSS v4.0 vector and exact evidence/rationale for every scored metric");
      }
    }
    if (disposition.disposition === "confirmed_code") {
      // Parser witnesses are a structural floor, not semantic reachability/impact proof.
      const witnesses = disposition.evidence.map((pointer) => {
        const source = input.corpus.files.get(pointer.path);
        if (source === undefined) throw new Error("Finding source missing");
        return resolveScaStructuralWitness({ ...pointer, source: source.text });
      });
      if (
        !witnesses.some((witness) => witness.status === "resolved" && witness.has_effect_node) ||
        !witnesses.some((witness) => witness.status === "resolved" && witness.has_data_flow_node)
      )
        missing.push(
          "parser-supported initiation/propagation and effect witnesses (not semantic proof)"
        );
    }
    const status =
      disposition.disposition === "confirmed_code"
        ? "Confirmed — code verified"
        : disposition.disposition === "probable"
          ? "Probable"
          : "Theoretical";
    const scoring_record_sha256 = sha256(
      canonicalJson({
        scoring,
        rationale: draft.scoring_rationale,
        metric_evidence: draft.metric_evidence,
        scorer: "penny:scoreScaCvssV4:FIRST-v4",
      })
    );
    return {
      ...draft,
      finding_id: `F-${sha256(canonicalJson({ hypothesis: hypothesis.id, invariant: hypothesis.violated_invariant, support: hypothesis.support.map((entry) => entry.path) })).slice(0, 24)}`,
      status,
      status_note: `${disposition.reason} Application observations: ${
        advanced.operations
          .filter((x) => x.stage === "application" && x.hypothesis_id === hypothesis.id)
          .map((x) => `${x.status}/${x.execution}`)
          .join(", ") || "NOT RUN"
      }; these do not independently confirm vulnerability or isolation.`,
      threat_id: hypothesis.threat_id,
      severity: scoring?.rating ?? "Unscored",
      scoring,
      scoring_record_sha256,
      missing: [...new Set(missing)],
    };
  });
  for (const finding of findings)
    if (finding.missing.length > 0)
      allGaps.push(`${finding.finding_id}: ${finding.missing.join("; ")}`);
  const candidates = input.preparation.leads.map((lead): ScaReportProduct["candidates"][number] => {
    const selections = input.selections
      .flatMap((selection) => selection.selections)
      .filter((selection) => selection.lead_ids.includes(lead.id));
    const deferred = input.selections
      .flatMap((selection) => selection.deferred)
      .find((entry) => entry.id === lead.id);
    if (selections.length === 0)
      allGaps.push(
        `${lead.id}: deferred candidate — ${deferred?.reason ?? "missing selection disposition"}`
      );
    const selectionIds = selections.map((entry) => entry.id);
    return {
      id: lead.id,
      decision: selections.length > 0 ? "selected" : "deferred",
      selection_ids: selectionIds,
      hypothesis_ids: input.hypotheses.hypotheses
        .filter((entry) => entry.selection_ids.some((id) => selectionIds.includes(id)))
        .map((entry) => entry.id),
      // The complete rationale already lives in selections; do not duplicate it
      // once per grouped lead in every report representation.
      note:
        selections.length > 0
          ? `${lead.title} — see selection rationale: ${selectionIds.join(", ")}.`
          : (deferred?.reason ?? "Unaccounted candidate; incomplete."),
    };
  });
  for (const chain of input.draft.chains) {
    for (const pointer of chain.evidence) verifyPointer(input.corpus, pointer);
    if (
      chain.hypothesis_ids.some(
        (id) =>
          !input.dispositions.dispositions.some(
            (entry) => entry.hypothesis_id === id && entry.disposition === "confirmed_code"
          )
      )
    )
      allGaps.push(
        "Cross-finding chain includes an unconfirmed component; no chain score or demonstrated impact is claimed."
      );
  }
  const focused = new Set(
    input.selections.flatMap((selection) =>
      selection.selections.flatMap((entry) => entry.ranges.map((range) => range.path))
    )
  );
  const coverage: ScaReportProduct["coverage"] = input.preparation.files.map((file) => ({
    path: file.path,
    state:
      file.language === "context"
        ? "unsupported"
        : focused.has(file.path)
          ? "focused"
          : "not_selected",
    reason: focused.has(file.path)
      ? "Selected ranges inspected; this is not a whole-file or whole-repository semantic coverage claim."
      : "Not selected for focused semantic inspection; scanner/graph capability accounting is separate, and silence is not safety.",
  }));
  const product = validateContract(
    ScaReportProductSchema,
    {
      schema_id: "penny.sca-report.v3",
      schema_version: 1,
      run_id: input.runId,
      source_snapshot_sha256: input.corpus.source_snapshot_sha256,
      scope: input.scope,
      status: allGaps.length === 0 ? "COMPLETE" : "INCOMPLETE",
      executive_summary: input.draft.executive_summary,
      graph_observations: (input.graphs ?? []).map((graph) => ({
        language: graph.language,
        graph_sha256: graph.graph_sha256,
        frontend_version: graph.tool_version,
        joern_version: input.graphConfig?.joern.version ?? null,
        queries: graph.query_observations.map((query) => ({
          id: query.query_id,
          script_sha256:
            input.graphConfig?.queries.find((entry) => entry.id === query.query_id)?.sha256 ?? null,
          raw_stdout_sha256: query.raw_stdout_sha256,
          observation_sha256: query.observation_sha256,
          complete: query.observation.complete,
          supported_files: query.observation.files.filter((file) => file.status === "supported")
            .length,
          unsupported_files: query.observation.files.filter((file) => file.status !== "supported")
            .length,
        })),
      })),
      preparation: input.preparation,
      selections: [...input.selections],
      hypotheses: input.hypotheses,
      dispositions: input.dispositions,
      learning: input.learning,
      findings,
      candidates,
      coverage,
      chains: input.draft.chains,
      evidence_refs: input.evidenceRefs,
      gaps: [...new Set(allGaps)],
      advanced,
      reproduction: execution,
      target_executed: execution === "UNKNOWN" ? null : execution === "RUN",
      representation_omissions: [
        "SARIF locations carry repository paths/ranges and finding IDs; full narrative, non-findings, learning and coverage are retained in run.properties and the canonical JSON/Markdown, not discarded.",
      ],
    },
    "SCA report product"
  );
  return sanitize(product, input.privatePaths);
}
function citation(pointer: { path: string; start_line: number; end_line: number }): string {
  return `${pointer.path}:${pointer.start_line}-${pointer.end_line}`;
}
function fenced(text: string, language: string): string {
  const fence = "`".repeat(Math.max(2, ...(text.match(/`+/gu) ?? []).map((run) => run.length)) + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}
function outsideFenceHeadings(markdown: string): string[] {
  let active: { mark: string; length: number } | undefined;
  const headings: string[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (match?.[1] !== undefined) {
      const marker = match[1];
      if (active === undefined) active = { mark: marker[0] ?? "", length: marker.length };
      else if (
        marker[0] === active.mark &&
        marker.length >= active.length &&
        /^\s*$/u.test(line.slice((match.index ?? 0) + match[0].length))
      )
        active = undefined;
      continue;
    }
    if (active === undefined && /^#{3,4} /u.test(line)) headings.push(line);
  }
  return headings;
}
export function renderScaOrdinaryMarkdown(report: ScaReportProduct): string {
  const r = validateContract(ScaReportProductSchema, report, "SCA report");
  const lines = [
    "# Source-composition security assessment",
    "",
    `**Status:** ${r.status}`,
    "",
    "## 1. Assessment identity, source snapshot and scope",
    "",
    `Run: ${r.run_id}`,
    `Snapshot: \`${r.source_snapshot_sha256}\``,
    `Scope filters (as supplied by caller): ${canonicalJson(r.scope)}`,
    `Admitted snapshot files: ${r.preparation.files.map((file) => `${file.path} (${file.lines} lines; SHA-256 ${file.content_sha256})`).join("; ")}. Empty filters do not add files beyond this snapshot.`,
    "",
    "## 2. Executive summary",
    "",
    r.executive_summary,
    "",
    `Completion describes the bounded assessment process, never repository safety. Scanner silence and model agreement are not vulnerability proof. Target execution: ${r.reproduction}.`,
    "",
    "## 3. Tools, rules, graphs, queries, model and runtime",
    "",
    `Models: deepseek-flash → ollama/deepseek-v4.1-flash:cloud. Structural checks: TypeScript ${tsVersion}; php-parser 3.7.0 / PHP 8.5; parsing only, no source evaluation. CVSS: deterministic scoreScaCvssV4, pinned FIRST v4 implementation. Exact configurations and observation digests:`,
    "",
    ...r.graph_observations.flatMap((graph) => [
      `- ${graph.language} graph: SHA-256 ${graph.graph_sha256}; frontend ${graph.frontend_version}; Joern ${graph.joern_version ?? "not supplied"}.`,
      ...graph.queries.map(
        (query) =>
          `  - Query ${query.id}: script ${query.script_sha256 ?? "not supplied"}; raw stdout ${query.raw_stdout_sha256}; normalized observation ${query.observation_sha256}; complete=${query.complete}; supported/unsupported files=${query.supported_files}/${query.unsupported_files}.`
      ),
    ]),
    ...r.preparation.capabilities.map(
      (cap) =>
        `- ${cap.id}: ${cap.status}; version ${cap.version ?? "unavailable"}; config ${cap.configuration_sha256 ?? "none"}; evidence ${cap.evidence_sha256 ?? "none"}. ${cap.detail}`
    ),
    "",
    "## 4. Actual coverage and retained limitation records",
    "",
    "Stage-time limitations are retained with their origin, not asserted to be current missing evidence. Later source observations may settle an earlier question; the executive summary must distinguish those resolutions from remaining unknowns. Retention is conservative and does not certify completeness or repository safety.",
    "",
    ...r.coverage.map((entry) => `- ${entry.path}: ${entry.state}. ${entry.reason}`),
    ...r.gaps.map((gap) => `- Limitation record: ${gap}`),
    "",
    "## 5. Reportable findings",
    "",
  ];
  if (r.findings.length === 0)
    lines.push(
      "No confirmed/reportable findings in the selected assessment. This is not a claim that the repository is safe."
    );
  for (const finding of r.findings) {
    lines.push(
      `### ${finding.finding_id} — ${finding.title} (${finding.severity})`,
      "",
      `- **Severity:** ${finding.scoring === null ? "Unscored — incomplete" : `${finding.severity} — ${finding.scoring.score.toFixed(1)} (${finding.scoring.nomenclature})`}`
    );
    if (finding.scoring !== null) {
      lines.push(`- **CVSS v4.0 Vector:** \`${finding.scoring.vector}\``);
      if (finding.scoring.nomenclature !== "CVSS-B")
        lines.push(
          `- **Base severity/vector:** ${finding.scoring.base_score.toFixed(1)} (CVSS-B), \`${finding.scoring.base_vector}\``
        );
    }
    lines.push(
      `- **Scoring rationale:** ${finding.scoring_rationale}; scorer record SHA-256 ${finding.scoring_record_sha256}. ${finding.metric_evidence.map((metric) => `${metric.metric}: ${metric.rationale} (${metric.evidence.map(citation).join(", ")})`).join("; ")}`,
      `- **CWE:** ${finding.cwe_id === null || finding.cwe_name === null ? "⚠ INCOMPLETE — missing: CWE identifier and name" : `${finding.cwe_id} (${finding.cwe_name})`}`,
      `- **Status:** ${finding.status} — ${finding.status_note}`,
      `- **Threat model:** ${finding.threat_id}`,
      ...(finding.missing.length === 0
        ? []
        : [`⚠ INCOMPLETE — missing: ${finding.missing.join("; ")}`]),
      "",
      "#### Description",
      finding.description,
      "",
      "#### Steps to Reproduce",
      `Application observations: ${
        r.advanced?.operations
          .filter((x) => x.stage === "application" && x.hypothesis_id === finding.hypothesis_id)
          .map((x) => `${x.status}/${x.execution}`)
          .join(", ") || "NOT RUN"
      }. No production exploit or deployment behavior is inferred.`,
      ...finding.prerequisites.map((prerequisite) => `- Prerequisite: ${prerequisite}`),
      ...finding.reproduction.map((step, index) => `${index + 1}. ${step}`),
      "",
      "#### Code Analysis",
      ...finding.code_analysis.map(
        (step, index) =>
          `${index + 1}. ${step.explanation} — \`${citation(step.pointer)}\`\n\n${fenced(step.pointer.exact_quote, "text")}`
      ),
      "",
      "#### Remediation",
      finding.remediation,
      ...finding.regression_tests.map((test) => `- Regression/fixed/negative test: ${test}`),
      `Compatibility and rollout risks: ${finding.compatibility_risks}`,
      ""
    );
  }
  lines.push(
    "## 6. Candidate/disposition reconciliation",
    "",
    ...r.selections.flatMap((selection, index) =>
      selection.selections.map(
        (entry) =>
          `- ${index === 0 ? "Scanner-led" : "No-alert"} focus ${entry.id}: ${entry.rationale}\n  Ranges: ${entry.ranges.map(citation).join(", ")}.`
      )
    ),
    ...r.candidates.map(
      (entry) =>
        `- ${entry.id}: ${entry.decision}; selections ${entry.selection_ids.join(", ") || "none"}; hypotheses ${entry.hypothesis_ids.join(", ") || "none"}. ${entry.note}`
    ),
    ...r.dispositions.dispositions.map(
      (entry) =>
        `- ${entry.hypothesis_id}: ${entry.disposition}${entry.duplicate_of === null ? "" : ` of ${entry.duplicate_of}`}. ${entry.reason} Evidence: ${entry.evidence.map(citation).join(", ") || "none"}. Counterevidence: ${entry.counterevidence.map(citation).join(", ") || "none supplied"}.`
    ),
    "",
    "## 7. Post-verification rule-learning result",
    "",
    r.learning.no_eligible_findings_reason ??
      "Verified issues assessed individually; candidates are not promoted or executed.",
    ...r.learning.outcomes.map(
      (entry) =>
        `- ${entry.hypothesis_id}: ${entry.status}. ${entry.reason}${entry.proposed_rule === null ? "" : `\n\n\`\`\`yaml\n${entry.proposed_rule}\n\`\`\`\nPositive test: ${entry.positive_test ?? "not provided"}; negative test: ${entry.negative_test ?? "not provided"}.`}`
    ),
    ...(r.advanced?.operations ?? []).map(
      (x) =>
        `- Host ${x.stage}/${x.selection_id}: ${x.status}; execution ${x.execution}; result ${x.result_sha256}; validation ${x.validation_sha256 ?? "none"}; release ${x.release_sha256 ?? "none"}; baseline unchanged=${x.baseline_unchanged}; unconfirmed rescan findings=${x.findings_count}.`
    ),
    "Current baseline is never replaced. Promotion is immutable and future-only; rescan requires a separate explicit caller operand. Missing authority does not execute work.",
    "",
    "## 8. Cross-finding chains and threat-model mapping",
    "",
    ...r.hypotheses.hypotheses.map(
      (entry) => `- ${entry.threat_id}: ${entry.violated_invariant}; ${entry.id}`
    ),
    ...(r.chains.length === 0
      ? ["No evidence-backed cross-finding chain established; no chain score is invented."]
      : r.chains.map(
          (entry) =>
            `- ${entry.hypothesis_ids.join(" → ")}: ${entry.established_composition}. Evidence: ${entry.evidence.map(citation).join(", ")}. Chain not separately CVSS-scored; no additional impact asserted.`
        )),
    "",
    "## 9. Output manifest and exact evidence/scoring/test references",
    "",
    "Markdown, canonical JSON and SARIF derive from this same accepted set. The terminal output manifest binds their exact bytes/digests and review artifacts. Application truth and exact host result hashes are recorded above; no production exploitation claim is made.",
    ...r.evidence_refs.map(
      (ref) =>
        `- ${ref.kind}: ${ref.artifact_id} / SHA-256 ${ref.content_digest} / ${ref.byte_length} bytes`
    ),
    ...r.representation_omissions.map((entry) => `- Representation note: ${entry}`),
    ""
  );
  return lines.join("\n");
}
export function renderScaOrdinarySarif(report: ScaReportProduct): unknown {
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "penny-sca",
            version: "3",
            rules: report.findings.map((finding) => ({
              id: finding.finding_id,
              shortDescription: { text: finding.title },
            })),
          },
        },
        properties: {
          source_snapshot_sha256: report.source_snapshot_sha256,
          status: report.status,
          graph_observations: report.graph_observations,
          candidates: report.candidates,
          selections: report.selections,
          dispositions: report.dispositions,
          coverage: report.coverage,
          learning: report.learning,
          ...(report.advanced === undefined ? {} : { advanced: report.advanced }),
          reproduction: report.reproduction,
          target_executed: report.target_executed,
          gaps: report.gaps,
          representation_omissions: report.representation_omissions,
        },
        results: report.findings.map((finding) => ({
          ruleId: finding.finding_id,
          message: { text: `${finding.title}: ${finding.status}` },
          level:
            finding.severity === "Critical" || finding.severity === "High"
              ? "error"
              : finding.severity === "Medium" || finding.severity === "Low"
                ? "warning"
                : "note",
          properties: finding,
          locations: finding.code_analysis.map((step) => ({
            physicalLocation: {
              artifactLocation: { uri: step.pointer.path, uriBaseId: "%SRCROOT%" },
              region: { startLine: step.pointer.start_line, endLine: step.pointer.end_line },
            },
          })),
        })),
      },
    ],
  };
}
/** Independent projection contract: do not derive this check from the SARIF renderer.
 * Candidate notes reference these complete records, including grouped/no-alert rationale,
 * ranges, deferrals and stage limitations, once in the run property bag. */
const SarifSelectionRecordsSchema = Type.Object({
  runs: Type.Array(
    Type.Object({
      properties: Type.Object({ selections: ScaReportProductSchema.properties.selections }),
    }),
    { minItems: 1, maxItems: 1 }
  ),
});
export function validateScaReportRepresentations(
  report: ScaReportProduct,
  markdown: string,
  sarif: unknown
): string[] {
  const issues: string[] = [];
  try {
    const projection = validateContract(SarifSelectionRecordsSchema, sarif, "SARIF selections");
    if (
      canonicalJson(projection.runs[0]?.properties.selections) !== canonicalJson(report.selections)
    )
      issues.push(
        "SARIF full selection records differ from canonical counts/IDs/rationales/evidence"
      );
  } catch {
    issues.push("SARIF missing or invalid full selection records");
  }
  if (
    markdown !== renderScaOrdinaryMarkdown(report) ||
    canonicalJson(sarif) !== canonicalJson(renderScaOrdinarySarif(report))
  )
    issues.push("cross-output exact accepted-set equality");
  if (
    report.status === "COMPLETE" &&
    (report.gaps.length > 0 ||
      report.findings.some((finding) => finding.missing.length > 0 || finding.scoring === null))
  )
    issues.push("complete report retains unresolved required material");
  if (scaP11HasSensitiveContent(markdown)) issues.push("sensitive data in rendered report");
  const expectedHeadings = report.findings.flatMap((finding) => [
    `### ${finding.finding_id} — ${finding.title} (${finding.severity})`,
    "#### Description",
    "#### Steps to Reproduce",
    "#### Code Analysis",
    "#### Remediation",
  ]);
  if (canonicalJson(outsideFenceHeadings(markdown)) !== canonicalJson(expectedHeadings))
    issues.push("exactly five ordered finding sections, excluding fenced quotations/code");
  for (const finding of report.findings) {
    if (
      finding.scoring !== null &&
      canonicalJson(scoreScaCvssV4(finding.scoring.vector)) !== canonicalJson(finding.scoring)
    )
      issues.push(`${finding.finding_id}: scoring mismatch`);
  }
  return issues;
}
