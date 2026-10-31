/** Independent canonical-to-SARIF preservation, without providers or target execution. */
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { validateContract } from "../dist/contracts.js";
import {
  ScaSelectionSchema,
  ScaReviewSchema,
  parseScaReview,
} from "../dist/sca/ordinary-contracts.js";
import { validateScaStageShape } from "../dist/sca/ordinary-semantic.js";
import { parsePersistedRoutingSummary } from "../dist/worker.js";
import {
  ScaReportProductSchema,
  renderScaOrdinaryMarkdown,
  renderScaOrdinarySarif,
  validateScaReportRepresentations,
} from "../dist/sca/ordinary-report.js";
import { isRecord } from "./helpers/sca-local-workflow.js";

function reportFixture() {
  const range = { path: "src/value.ts", start_line: 1, end_line: 2 };
  return validateContract(
    ScaReportProductSchema,
    {
      schema_id: "penny.sca-report.v3",
      schema_version: 1,
      run_id: "report-preservation",
      source_snapshot_sha256: sha256("snapshot"),
      scope: { include: [], exclude: [] },
      status: "INCOMPLETE",
      executive_summary: "Leads were investigated; no hypothesis was formed. Not safety proof.",
      preparation: {
        schema_version: 1,
        source_snapshot_sha256: sha256("snapshot"),
        capabilities: [
          {
            id: "advisories",
            status: "completed",
            detail: "No resolved external coordinates require matching; no OSV query needed.",
            version: "offline",
            configuration_sha256: null,
            evidence_sha256: sha256("inventory"),
          },
        ],
        files: [
          {
            path: range.path,
            content_sha256: sha256("source"),
            lines: 2,
            language: "javascript_typescript",
          },
        ],
        leads: ["lead-a", "lead-b", "lead-deferred"].map((id) => ({
          id,
          origin: "graph",
          title: `Observed relation ${id}`,
          locations: [range],
          evidence_sha256: sha256(id),
        })),
        gaps: [],
      },
      graph_observations: [],
      selections: [
        {
          schema_version: 1,
          selections: [
            {
              id: "grouped",
              lead_ids: ["lead-a", "lead-b"],
              rationale:
                "Inspect both relations together. Preserve this full second sentence, punctuation and Unicode: λ.",
              ranges: [range],
            },
          ],
          deferred: [
            {
              id: "lead-deferred",
              reason: "Deferred with the complete evidence-bounded explanation.",
            },
          ],
          gaps: ["Historical selection limitation."],
        },
        {
          schema_version: 1,
          selections: [
            {
              id: "no-alert",
              lead_ids: [],
              rationale:
                "Independently inspect a no-alert surface; this rationale is not a lead title.",
              ranges: [range],
            },
          ],
          deferred: [],
          gaps: [],
        },
      ],
      hypotheses: {
        schema_version: 1,
        hypotheses: [],
        unformed: [
          { selection_id: "grouped", reason: "No security effect established." },
          { selection_id: "no-alert", reason: "No falsifiable violation established." },
        ],
        gaps: [],
      },
      dispositions: { schema_version: 1, dispositions: [], gaps: [] },
      learning: {
        schema_version: 1,
        outcomes: [],
        no_eligible_findings_reason: "No formed or confirmed-code hypotheses.",
        baseline_unchanged: true,
        promotion_performed: false,
        rescan: "not_run",
        gaps: [],
      },
      findings: [],
      candidates: ["lead-a", "lead-b", "lead-deferred"].map((id) => ({
        id,
        decision: id === "lead-deferred" ? "deferred" : "selected",
        selection_ids: id === "lead-deferred" ? [] : ["grouped"],
        hypothesis_ids: [],
        note:
          id === "lead-deferred"
            ? "Deferred with reason retained."
            : "See selection rationale: grouped.",
      })),
      coverage: [
        {
          path: range.path,
          state: "focused",
          reason: "Selected ranges, not whole-repository proof.",
        },
      ],
      chains: [],
      evidence_refs: [
        {
          schema_version: 2,
          artifact_id: `art_${"a".repeat(64)}`,
          run_id: "report-preservation",
          phase: "preparing_analysis",
          branch_id: null,
          kind: "sca-preparation-result",
          operation_id: "fixture",
          version: 1,
          producer: "host:fixture",
          media_type: "application/json",
          byte_length: 2,
          content_digest: sha256("{}"),
          store_ref: `artifact://sha256/${sha256("{}")}`,
        },
      ],
      gaps: ["Historical selection limitation."],
      reproduction: "NOT RUN",
      target_executed: false,
      representation_omissions: [],
    },
    "Canonical report fixture"
  );
}
function properties(sarif: unknown): Record<string, unknown> {
  if (!isRecord(sarif) || !Array.isArray(sarif.runs) || sarif.runs.length !== 1)
    throw new Error("Missing single SARIF run");
  const run: unknown = sarif.runs[0];
  if (!isRecord(run) || !isRecord(run.properties)) throw new Error("Missing SARIF property bag");
  return run.properties;
}
describe("closed ordinary review failure shapes", () => {
  const pass = {
    schema_version: 1,
    report_artifact_id: `art_${"a".repeat(64)}`,
    report_sha256: "b".repeat(64),
    verdict: "PASS",
    checked_evidence_ids: [`art_${"c".repeat(64)}`],
    claim_support: true,
    counterevidence_addressed: true,
    execution_truth: true,
    scoring_semantics: true,
    redaction: true,
    report_quality: true,
    issues: [],
  };
  it.each([
    { gaps: [] },
    { gaps: ["Complete supplied-artifact coverage; no numeric score to assess."] },
  ])(
    "rejects the retained extra-gaps PASS shape even with $gaps and leaves the raw response unchanged",
    ({ gaps }) => {
      const rejected = { ...pass, gaps };
      const before = canonicalJson(rejected);
      expect(() => validateScaStageShape(ScaReviewSchema, rejected)).toThrow("schema_invalid");
      expect(() => parseScaReview(rejected)).toThrow();
      expect(canonicalJson(rejected)).toBe(before);
    }
  );
  it("rejects the retained nonempty-issues PASS shape independently of unknown fields", () => {
    const rejected = {
      ...pass,
      issues: [
        "Note (no correction required; recorded so PASS is not read as broader than it is).",
      ],
    };
    const before = canonicalJson(rejected);
    expect(() => validateScaStageShape(ScaReviewSchema, rejected)).not.toThrow();
    expect(() => parseScaReview(rejected)).toThrow("contradicts its checks/issues");
    expect(canonicalJson(rejected)).toBe(before);
  });
  it("accepts a schema-valid PASS and an actionable genuine GAP without waiving checks", () => {
    expect(parseScaReview(pass)).toEqual(pass);
    const gap = {
      ...pass,
      verdict: "GAP",
      claim_support: false,
      issues: [
        "Executive summary: nonempty leads are described as an empty candidate pool. Distinguish leads from formed hypotheses using the canonical records.",
      ],
    };
    expect(parseScaReview(gap)).toEqual(gap);
    expect(() => parseScaReview({ ...pass, verdict: "GAP" })).toThrow();
    expect(() => parseScaReview({ ...pass, report_quality: false })).toThrow();
  });
  it("keeps transport confidence in the existing footer parser, not the semantic schema", () => {
    const footer = { ...pass, confidence: "PROBABLE" };
    expect(() => parseScaReview(footer)).toThrow();
    const routing = parsePersistedRoutingSummary(`SUMMARY:${canonicalJson(footer)}`);
    if (routing === undefined) throw new Error("Missing parsed footer");
    expect(parseScaReview(routing.details)).toEqual(pass);
  });
});

describe("ordinary report full selection preservation", () => {
  it("carries both accepted selection records once, with all IDs, full rationales, ranges, deferrals and gaps", () => {
    const report = reportFixture();
    const before = canonicalJson(report);
    const sarif = renderScaOrdinarySarif(report);
    const bag = properties(sarif);
    // The oracle is the canonical data, not a second call to the renderer.
    expect(bag.selections).toEqual(report.selections);
    expect(bag.candidates).toEqual(report.candidates);
    for (const selection of report.selections.flatMap((stage) => stage.selections)) {
      expect(canonicalJson(sarif).split(JSON.stringify(selection.rationale))).toHaveLength(2);
    }
    expect(
      validateScaReportRepresentations(report, renderScaOrdinaryMarkdown(report), sarif)
    ).toEqual([]);
    expect(canonicalJson(report)).toBe(before);
  });
  it.each([
    "delete-bag",
    "delete-stage",
    "delete-selection",
    "duplicate-selection",
    "foreign-id",
    "truncate-rationale",
    "delete-deferral",
    "change-range",
    "delete-gap",
  ])("independently detects %s without relying only on renderer equality", (mutation) => {
    const report = reportFixture();
    const before = canonicalJson(report);
    const sarif = structuredClone(renderScaOrdinarySarif(report));
    const bag = properties(sarif);
    if (!Array.isArray(bag.selections)) throw new Error("Missing rendered selection records");
    const stages = bag.selections.map((stage: unknown) =>
      validateContract(ScaSelectionSchema, stage, "SARIF selection fixture")
    );
    const stage = stages[0],
      selection = stage?.selections[0];
    if (stage === undefined || selection === undefined)
      throw new Error("Missing grouped selection");
    if (mutation === "delete-bag") delete bag.selections;
    else {
      bag.selections = stages;
      if (mutation === "delete-stage") stages.pop();
      if (mutation === "delete-selection") stage.selections.pop();
      if (mutation === "duplicate-selection") stage.selections.push(structuredClone(selection));
      if (mutation === "foreign-id") selection.id = "foreign";
      if (mutation === "truncate-rationale")
        selection.rationale = selection.rationale.split(".")[0] ?? "Truncated";
      if (mutation === "delete-deferral") stage.deferred = [];
      if (mutation === "change-range")
        selection.ranges[0] = { path: "other.ts", start_line: 1, end_line: 1 };
      if (mutation === "delete-gap") stage.gaps = [];
    }
    const issues = validateScaReportRepresentations(
      report,
      renderScaOrdinaryMarkdown(report),
      sarif
    );
    expect(issues.some((issue) => issue.startsWith("SARIF "))).toBe(true);
    expect(canonicalJson(report)).toBe(before);
  });
});
