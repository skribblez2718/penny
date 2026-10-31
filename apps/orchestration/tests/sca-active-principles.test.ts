import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  adjudicateScaReviewV2,
  buildScaCoverageLedgerV1,
  buildScaReleaseProjectionV1,
  parseSealedScaSourceCorpusV1,
  type ParsedScaSourceCorpusV1,
  type ScaAnalysisSummaryV2,
  type ScaEvidenceProvenanceV1,
  type ScaHostStaticInventoryV2,
} from "../dist/sca/active-compliance.js";
import {
  createScaFindingFingerprint,
  normalizeScaFindingPath,
  resolveScaStructuralSymbol,
  resolveScaStructuralWitness,
  scaStructuralParserCapability,
} from "../dist/sca/active-symbol-resolution.js";

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceFixture(files: Readonly<Record<string, string>>): {
  readonly bytes: Buffer;
  readonly corpus: ParsedScaSourceCorpusV1;
  readonly inventory: ScaHostStaticInventoryV2;
} {
  const snapshotSha256 = "1".repeat(64);
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
  const metadata = {
    schema_id: "penny.sca-source-corpus.v1",
    schema_version: 1,
    source_snapshot_sha256: snapshotSha256,
    text_file_count: entries.length,
    excluded_files: [],
    frame_format: "Length-framed test corpus.",
  };
  const parts = [Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8")];
  for (const [filePath, source] of entries) {
    const frame = {
      path: filePath,
      byte_length: Buffer.byteLength(source),
      content_sha256: digest(source),
    };
    parts.push(
      Buffer.from(
        `SCA_SOURCE_FILE ${JSON.stringify(frame)}\n${source}\nSCA_SOURCE_FILE_END\n`,
        "utf8"
      )
    );
  }
  const bytes = Buffer.concat(parts);
  const corpus = parseSealedScaSourceCorpusV1(bytes);
  const inventory: ScaHostStaticInventoryV2 = {
    schema_id: "penny.sca-host-static-inventory.v2",
    schema_version: 2,
    source_snapshot_sha256: snapshotSha256,
    computed_source_snapshot_sha256: snapshotSha256,
    scope: { include: [], exclude: [] },
    model_invocation_count: 0,
    discovery_mode: "independent_full_source_analysis",
    file_count: entries.length,
    byte_count: entries.reduce((total, [, source]) => total + Buffer.byteLength(source), 0),
    files: entries.map(([filePath, source]) => ({
      path: filePath,
      byte_length: Buffer.byteLength(source),
      content_sha256: digest(source),
    })),
    source_corpus_text_file_count: entries.length,
    source_corpus_exclusions: [],
    structural_parser_blockers: [],
    source_corpus_artifact_id: `art_${"3".repeat(64)}`,
    source_corpus_sha256: digest(bytes),
    analysis_gaps: [],
  };
  return { bytes, corpus, inventory };
}

function provenance(corpusBytes: Buffer): ScaEvidenceProvenanceV1 {
  return {
    schema_version: 1,
    source_corpus: { artifact_id: `art_${"3".repeat(64)}`, sha256: digest(corpusBytes) },
    inventory: { artifact_id: `art_${"4".repeat(64)}`, sha256: "4".repeat(64) },
    analyses: [
      {
        profile_id: "primary_a",
        artifact_id: `art_${"5".repeat(64)}`,
        sha256: "5".repeat(64),
      },
      {
        profile_id: "primary_b",
        artifact_id: `art_${"6".repeat(64)}`,
        sha256: "6".repeat(64),
      },
    ],
    candidate_ledger: { artifact_id: `art_${"8".repeat(64)}`, sha256: "8".repeat(64) },
    review: { artifact_id: `art_${"7".repeat(64)}`, sha256: "7".repeat(64) },
    structural_engine: { name: "typescript-compiler-api", version: "6.0.3" },
    php_structural_parser: {
      status: "available",
      name: "php-parser",
      version: "3.7.0",
      php_language_version: "8.5",
      parse_api: "parseCode",
      ast_positions: true,
      evaluates_source: false,
    },
    protocol_ids: [
      "penny.sca-independent-full-source-analysis.v1",
      "penny.sca-host-quoted-structural-evidence.v1",
    ],
  };
}

function analysis(input: {
  readonly profile: "primary_a" | "primary_b";
  readonly path: string;
  readonly quote: string;
  readonly candidateIds?: readonly string[];
  readonly status?: "analyzed" | "blocked";
}): ScaAnalysisSummaryV2 {
  const candidateIds = [...(input.candidateIds ?? [])];
  const coverageRecord =
    input.status === "blocked"
      ? { path: input.path, status: "blocked" as const, reason: "Source could not be analyzed." }
      : {
          path: input.path,
          status: "analyzed" as const,
          analysis_summary:
            "Reviewed declarations, data origins, control flow, effects, and security-relevant boundaries in this source unit.",
          evidence: [
            {
              path: input.path,
              start_line: 1,
              end_line: 1,
              exact_quote: input.quote,
            },
          ],
          candidate_ids: candidateIds,
          limitations: [],
        };
  return {
    schema_version: 2,
    complete: true,
    profile_id: input.profile,
    candidate_ids: candidateIds,
    confirmed_candidate_ids: candidateIds,
    rejected_candidate_ids: [],
    inconclusive_candidate_ids: [],
    coverage_records: [coverageRecord],
    gaps: [],
  };
}

function credibleAssessments(coverage: ReturnType<typeof buildScaCoverageLedgerV1>): Array<{
  obligation_id: string;
  profile_id: "primary_a" | "primary_b";
  coverage_record_sha256: string;
  assessment: "credible";
  reason: string;
}> {
  return coverage.obligations.flatMap((obligation) =>
    (["primary_a", "primary_b"] as const).flatMap((profileId) => {
      const record = obligation[profileId];
      return record.status === "analyzed"
        ? [
            {
              obligation_id: obligation.obligation_id,
              profile_id: profileId,
              coverage_record_sha256: record.coverage_record_sha256,
              assessment: "credible" as const,
              reason:
                "The structured summary and exact source-bound quote demonstrate a substantive per-unit review.",
            },
          ]
        : [];
    })
  );
}

describe("active SCA constitutional gates", () => {
  it("keeps fingerprints stable across indentation and nearby edits while resolving declaration lines", () => {
    const firstSource = [
      "export class Runner {",
      "  execute(input: string) {",
      "    return eval(input);",
      "  }",
      "}",
    ].join("\n");
    const editedSource = [
      "// nearby edit",
      "export class Runner {",
      "    execute(command: string) {",
      "      const normalized = command.trim();",
      "      return eval(normalized);",
      "    }",
      "}",
    ].join("\n");
    const declaration = resolveScaStructuralSymbol({
      path: "src/runner.ts",
      source: firstSource,
      line: 2,
    });
    const first = resolveScaStructuralSymbol({
      path: "src/runner.ts",
      source: firstSource,
      line: 3,
    });
    const edited = resolveScaStructuralSymbol({
      path: "src/runner.ts",
      source: editedSource,
      line: 5,
    });
    expect(declaration).toMatchObject({
      status: "resolved",
      symbol: "class:Runner/method:execute",
    });
    expect(first).toMatchObject({ status: "resolved", symbol: "class:Runner/method:execute" });
    expect(edited).toMatchObject({ status: "resolved", symbol: "class:Runner/method:execute" });
    if (first.status !== "resolved" || edited.status !== "resolved") {
      throw new Error("test symbols did not resolve");
    }
    const firstFingerprint = createScaFindingFingerprint({
      path: "src/runner.ts",
      symbol: first.symbol,
      vulnerability_class: "code-injection",
    });
    const editedFingerprint = createScaFindingFingerprint({
      path: "src/runner.ts",
      symbol: edited.symbol,
      vulnerability_class: "code-injection",
    });
    expect(editedFingerprint.sha256).toBe(firstFingerprint.sha256);
    expect(firstFingerprint).not.toHaveProperty("line");
    expect(firstFingerprint).not.toHaveProperty("snippet");
  });

  it("gives distinct object callbacks and named top-level calls meaningful structural identities", () => {
    const source = [
      "const first = { handler: () => execute('first') };",
      "const second = { handler: () => execute('second') };",
      "register('route', () => execute('third'));",
    ].join("\n");
    const first = resolveScaStructuralSymbol({ path: "src/routes.ts", source, line: 1 });
    const second = resolveScaStructuralSymbol({ path: "src/routes.ts", source, line: 2 });
    const callback = resolveScaStructuralSymbol({ path: "src/routes.ts", source, line: 3 });
    expect(first).toMatchObject({ status: "resolved" });
    expect(second).toMatchObject({ status: "resolved" });
    expect(callback).toMatchObject({ status: "resolved" });
    if (
      first.status !== "resolved" ||
      second.status !== "resolved" ||
      callback.status !== "resolved"
    ) {
      throw new Error("test symbols did not resolve");
    }
    expect(first.symbol).not.toBe(second.symbol);
    expect(first.symbol).toContain("binding:first");
    expect(second.symbol).toContain("binding:second");
    expect(callback.symbol).toContain("callback:register[arg1=string:route]:arg2");
    expect([first.symbol, second.symbol, callback.symbol]).not.toContain("module:<module>");
  });

  it("keeps named-function identity stable across body bindings and unrelated same-name calls", () => {
    const original = [
      "export function handler(input: string) {",
      "  return execute(input);",
      "}",
      "register('target', () => execute('target'));",
    ].join("\n");
    const edited = [
      "register('unrelated', () => execute('other'));",
      "export function handler(input: string) {",
      "  const normalized = input.trim();",
      "  return execute(normalized);",
      "}",
      "register('target', () => execute('target'));",
    ].join("\n");
    expect(
      resolveScaStructuralSymbol({ path: "src/handlers.ts", source: original, line: 2 })
    ).toMatchObject({ status: "resolved", symbol: "function:handler" });
    expect(
      resolveScaStructuralSymbol({ path: "src/handlers.ts", source: edited, line: 3 })
    ).toMatchObject({ status: "resolved", symbol: "function:handler" });
    const beforeCallback = resolveScaStructuralSymbol({
      path: "src/handlers.ts",
      source: original,
      line: 4,
    });
    const afterCallback = resolveScaStructuralSymbol({
      path: "src/handlers.ts",
      source: edited,
      line: 6,
    });
    expect(beforeCallback).toMatchObject({ status: "resolved" });
    expect(afterCallback).toEqual(beforeCallback);
  });

  it("distinguishes stable sibling callbacks and refuses ambiguous anonymous ownership", () => {
    const named = [
      "const routes = {",
      "  alpha: () => execute('alpha'),",
      "  beta: () => execute('beta'),",
      "};",
    ].join("\n");
    const alpha = resolveScaStructuralSymbol({ path: "src/routes.ts", source: named, line: 2 });
    const beta = resolveScaStructuralSymbol({ path: "src/routes.ts", source: named, line: 3 });
    expect(alpha).toMatchObject({
      status: "resolved",
      symbol: "binding:routes/property:alpha",
    });
    expect(beta).toMatchObject({
      status: "resolved",
      symbol: "binding:routes/property:beta",
    });

    const duplicate = [
      "register('same', () => execute('first'));",
      "register('same', () => execute('second'));",
    ].join("\n");
    expect(
      resolveScaStructuralSymbol({ path: "src/duplicate.ts", source: duplicate, line: 1 })
    ).toMatchObject({ status: "unsupported", reason_code: "unresolvable_symbol" });

    const anonymousArray = [
      "const callbacks = [",
      "  () => execute('first'),",
      "  () => execute('second'),",
      "];",
    ].join("\n");
    expect(
      resolveScaStructuralSymbol({ path: "src/anonymous.ts", source: anonymousArray, line: 2 })
    ).toMatchObject({ status: "unsupported", reason_code: "unresolvable_symbol" });
  });

  it("preserves nested identical declaration names and limits witnesses to cited syntax", () => {
    const nested = [
      "namespace Same {",
      "  export namespace Same {",
      "    export class Same {",
      "      Same(input: string) {",
      "        return execute(input);",
      "      }",
      "    }",
      "  }",
      "}",
    ].join("\n");
    expect(
      resolveScaStructuralSymbol({ path: "src/nested.ts", source: nested, line: 5 })
    ).toMatchObject({
      status: "resolved",
      symbol: "namespace:Same/namespace:Same/class:Same/method:Same",
    });

    const multiline = [
      "export function handler(input: string) {",
      "  return execute(",
      "    input",
      "  );",
      "}",
    ].join("\n");
    expect(
      resolveScaStructuralWitness({
        path: "src/multiline.ts",
        source: multiline,
        start_line: 3,
        end_line: 3,
      })
    ).toMatchObject({
      status: "resolved",
      symbol: "function:handler",
      has_data_flow_node: true,
      has_effect_node: false,
    });
  });

  it("refuses parser diagnostics and truly anonymous scope instead of using a module fallback", () => {
    expect(
      resolveScaStructuralSymbol({
        path: "src/broken.ts",
        source: "export function broken( {",
        line: 1,
      })
    ).toMatchObject({ status: "unsupported", reason_code: "parser_diagnostics" });
    expect(
      resolveScaStructuralSymbol({
        path: "src/literal.ts",
        source: "42;",
        line: 1,
      })
    ).toEqual({
      status: "unsupported",
      reason_code: "unresolvable_symbol",
      detail:
        "The cited location has no stable named or structural scope; module fallback identities are prohibited.",
    });
  });

  it("parses PHP source structurally and fails closed on PHP diagnostics", () => {
    const source = [
      "<?php",
      "namespace App\\Security;",
      "class Runner {",
      "  public function execute($input) {",
      "    return system($input);",
      "  }",
      "}",
    ].join("\n");
    expect(scaStructuralParserCapability("src/Runner.php")).toMatchObject({
      status: "available",
      language: "php",
      parser_id: "php-parser-3.7.0-php8.5",
    });
    expect(resolveScaStructuralSymbol({ path: "src/Runner.php", source, line: 5 })).toMatchObject({
      status: "resolved",
      language: "php",
      parser_id: "php-parser-3.7.0-php8.5",
      symbol: "namespace:App\\Security/class:Runner/method:execute",
    });
    const functionSource = [
      "<?php",
      "namespace App\\Security;",
      "function execute($input) {",
      "  return system($input);",
      "}",
    ].join("\n");
    expect(
      resolveScaStructuralSymbol({
        path: "src/functions.php",
        source: functionSource,
        line: 4,
      })
    ).toMatchObject({
      status: "resolved",
      symbol: "namespace:App\\Security/function:execute",
    });
    expect(
      resolveScaStructuralSymbol({
        path: "src/broken.php",
        source: "<?php function broken( {",
        line: 1,
      })
    ).toMatchObject({ status: "unsupported", reason_code: "parser_diagnostics" });
  });

  it("requires structural pointers to contain complete parser-owned data-flow and effect nodes", () => {
    const scriptSource = [
      'import { exec } from "node:child_process";',
      "export function commandRoute(command: string): void {",
      "  exec(command, (error) => {",
      "    if (error) throw error;",
      "  });",
      "}",
    ].join("\n");
    expect(
      resolveScaStructuralWitness({
        path: "src/command-route.ts",
        source: scriptSource,
        start_line: 3,
        end_line: 3,
      })
    ).toMatchObject({ status: "resolved", has_effect_node: false });
    expect(
      resolveScaStructuralWitness({
        path: "src/command-route.ts",
        source: scriptSource,
        start_line: 3,
        end_line: 5,
      })
    ).toMatchObject({ status: "resolved", has_effect_node: true });

    const phpSource = [
      "<?php",
      "namespace Qualification;",
      "",
      "final class LegacyController {",
      "    public function run(): void {",
      "        $command = $_GET['command'] ?? '';",
      "        system($command);",
      "    }",
      "}",
    ].join("\n");
    expect(
      resolveScaStructuralWitness({
        path: "src/legacy.php",
        source: phpSource,
        start_line: 5,
        end_line: 5,
      })
    ).toMatchObject({ status: "resolved", has_data_flow_node: false });
    expect(
      resolveScaStructuralWitness({
        path: "src/legacy.php",
        source: phpSource,
        start_line: 5,
        end_line: 6,
      })
    ).toMatchObject({ status: "resolved", has_data_flow_node: true });
  });

  it("requires source-bound per-unit analysis from both branches and independent credibility review", () => {
    const fixture = sourceFixture({ "src/unit.ts": "export const unit = 1;" });
    const summaries = [
      analysis({
        profile: "primary_a",
        path: "src/unit.ts",
        quote: "export const unit = 1;",
      }),
      analysis({
        profile: "primary_b",
        path: "src/unit.ts",
        quote: "export const unit = 1;",
      }),
    ];
    const pending = buildScaCoverageLedgerV1({
      inventory: fixture.inventory,
      corpus: fixture.corpus,
      summaries,
    });
    expect(pending).toMatchObject({
      analysis_admission_gate: { status: "passed", issue_count: 0 },
      completeness_gate: { status: "pending_independent_review", issue_count: 0 },
      no_candidate_file_count: 1,
    });
    const ledger = adjudicateScaReviewV2({
      review: {
        schema_version: 2,
        verdict: "PASS",
        coverage_assessments: credibleAssessments(pending),
        canonical_candidates: [],
        gaps: [],
      },
      raw_candidate_ids: [],
      coverage: pending,
      inventory: fixture.inventory,
      corpus: fixture.corpus,
      provenance: provenance(fixture.bytes),
    });
    expect(ledger.coverage.completeness_gate).toMatchObject({
      status: "passed",
      issue_count: 0,
    });
  });

  it("fails closed on corpus-global citation ranges from the live primary-output shape", () => {
    const commandSource = [
      'import { exec } from "node:child_process";',
      "",
      "interface Request {",
      "  readonly query: { readonly command: string };",
      "}",
      "",
      "interface Response {",
      "  send(body: string): void;",
      "}",
      "",
      "export function commandRoute(request: Request, response: Response): void {",
      "  const command = request.query.command;",
      "  exec(command, (error, stdout) => {",
      '    response.send(error === null ? stdout : "command failed");',
      "  });",
      "}",
      "",
    ].join("\n");
    const legacySource = [
      "<?php",
      "namespace Qualification;",
      "",
      "final class LegacyController {",
      "    public function run(): void {",
      "        $command = $_GET['command'] ?? '';",
      "        system($command);",
      "    }",
      "}",
      "",
    ].join("\n");
    const safeSource = [
      "export function renderGreeting(name: string): string {",
      '  return `Hello, ${name.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}`;',
      "}",
      "",
    ].join("\n");
    const fixture = sourceFixture({
      "src/command-route.ts": commandSource,
      "src/legacy.php": legacySource,
      "src/safe.ts": safeSource,
    });
    const primaryA: ScaAnalysisSummaryV2 = {
      schema_version: 2,
      complete: true,
      profile_id: "primary_a",
      candidate_ids: [],
      confirmed_candidate_ids: [],
      rejected_candidate_ids: [],
      inconclusive_candidate_ids: [],
      coverage_records: [
        {
          path: "src/command-route.ts",
          status: "analyzed",
          analysis_summary: "Reviewed the command handler and its effect-bearing call.",
          evidence: [
            {
              path: "src/command-route.ts",
              start_line: 1,
              end_line: 1,
              exact_quote: 'import { exec } from "node:child_process";',
            },
          ],
          candidate_ids: [],
          limitations: [],
        },
        {
          path: "src/legacy.php",
          status: "analyzed",
          analysis_summary: "Reviewed the PHP controller and its effect-bearing call.",
          evidence: [
            {
              path: "src/legacy.php",
              start_line: 1,
              end_line: 1,
              exact_quote: "<?php",
            },
          ],
          candidate_ids: [],
          limitations: [],
        },
        {
          path: "src/safe.ts",
          status: "analyzed",
          analysis_summary: "Reviewed the greeting renderer and its output transformation.",
          evidence: [
            {
              path: "src/safe.ts",
              start_line: 1,
              end_line: 1,
              exact_quote: "export function renderGreeting(name: string): string {",
            },
          ],
          candidate_ids: [],
          limitations: [],
        },
      ],
      gaps: [],
    };
    const primaryB: ScaAnalysisSummaryV2 = {
      ...primaryA,
      profile_id: "primary_b",
      coverage_records: [
        {
          path: "src/command-route.ts",
          status: "analyzed",
          analysis_summary: "Reviewed the command handler and its effect-bearing call.",
          evidence: [
            {
              path: "src/command-route.ts",
              start_line: 3,
              end_line: 3,
              exact_quote: 'import { exec } from "node:child_process";',
            },
            {
              path: "src/command-route.ts",
              start_line: 13,
              end_line: 18,
              exact_quote: commandSource.split("\n").slice(10, 16).join("\n"),
            },
          ],
          candidate_ids: [],
          limitations: [],
        },
        {
          path: "src/legacy.php",
          status: "analyzed",
          analysis_summary: "Reviewed the PHP controller and its effect-bearing call.",
          evidence: [
            {
              path: "src/legacy.php",
              start_line: 22,
              end_line: 23,
              exact_quote: legacySource.split("\n").slice(0, 2).join("\n"),
            },
            {
              path: "src/legacy.php",
              start_line: 25,
              end_line: 30,
              exact_quote: legacySource.split("\n").slice(3, 9).join("\n"),
            },
          ],
          candidate_ids: [],
          limitations: [],
        },
        {
          path: "src/safe.ts",
          status: "analyzed",
          analysis_summary: "Reviewed the greeting renderer and its output transformation.",
          evidence: [
            {
              path: "src/safe.ts",
              start_line: 34,
              end_line: 36,
              exact_quote: safeSource.split("\n").slice(0, 3).join("\n"),
            },
          ],
          candidate_ids: [],
          limitations: [],
        },
      ],
    };

    const ledger = buildScaCoverageLedgerV1({
      inventory: fixture.inventory,
      corpus: fixture.corpus,
      summaries: [primaryA, primaryB],
    });

    expect(ledger.analysis_admission_gate).toEqual({
      owner: "host",
      status: "failed",
      issue_count: 8,
    });
    for (const obligation of ledger.obligations) {
      expect(obligation.primary_a.status).toBe("analyzed");
      expect(obligation.primary_b.status).toBe("analyzed");
      if (obligation.primary_b.status === "analyzed") {
        expect(obligation.primary_b.evidence).toEqual([]);
      }
    }
  });

  it("fails coverage when a branch is blocked or independent assessment cannot match the source-bound record", () => {
    const fixture = sourceFixture({ "src/unit.ts": "export const unit = 1;" });
    const blocked = buildScaCoverageLedgerV1({
      inventory: fixture.inventory,
      corpus: fixture.corpus,
      summaries: [
        analysis({
          profile: "primary_a",
          path: "src/unit.ts",
          quote: "export const unit = 1;",
          status: "blocked",
        }),
        analysis({
          profile: "primary_b",
          path: "src/unit.ts",
          quote: "export const unit = 1;",
        }),
      ],
    });
    expect(blocked.analysis_admission_gate.status).toBe("failed");

    const admitted = buildScaCoverageLedgerV1({
      inventory: fixture.inventory,
      corpus: fixture.corpus,
      summaries: [
        analysis({
          profile: "primary_a",
          path: "src/unit.ts",
          quote: "export const unit = 1;",
        }),
        analysis({
          profile: "primary_b",
          path: "src/unit.ts",
          quote: "export const unit = 1;",
        }),
      ],
    });
    const assessments = credibleAssessments(admitted);
    const first = assessments[0];
    if (first === undefined) throw new Error("coverage assessment fixture is absent");
    const mismatched = [
      { ...first, coverage_record_sha256: "0".repeat(64) },
      ...assessments.slice(1),
    ];
    const ledger = adjudicateScaReviewV2({
      review: {
        schema_version: 2,
        verdict: "PASS",
        coverage_assessments: mismatched,
        canonical_candidates: [],
        gaps: [],
      },
      raw_candidate_ids: [],
      coverage: admitted,
      inventory: fixture.inventory,
      corpus: fixture.corpus,
      provenance: provenance(fixture.bytes),
    });
    expect(ledger.coverage.completeness_gate.status).toBe("failed");
  });

  it("host-computes citation hashes and promotes substantive parser-witnessed evidence", () => {
    const source = [
      "export function handler(request: string) {",
      "  return execute(request);",
      "}",
    ].join("\n");
    const fixture = sourceFixture({ "src/handler.ts": source });
    const candidateId = "primary_a:command-flow";
    const summaries = [
      analysis({
        profile: "primary_a",
        path: "src/handler.ts",
        quote: "export function handler(request: string) {",
        candidateIds: [candidateId],
      }),
      analysis({
        profile: "primary_b",
        path: "src/handler.ts",
        quote: "export function handler(request: string) {",
      }),
    ];
    const coverage = buildScaCoverageLedgerV1({
      inventory: fixture.inventory,
      corpus: fixture.corpus,
      summaries,
    });
    const entrypoint = {
      path: "src/handler.ts",
      start_line: 1,
      end_line: 1,
      exact_quote: "export function handler(request: string) {",
    };
    const sink = {
      path: "src/handler.ts",
      start_line: 2,
      end_line: 2,
      exact_quote: "  return execute(request);",
    };
    const ledger = adjudicateScaReviewV2({
      review: {
        schema_version: 2,
        verdict: "PASS",
        coverage_assessments: credibleAssessments(coverage),
        canonical_candidates: [
          {
            canonical_id: "command-flow",
            raw_candidate_ids: [candidateId],
            disposition: "confirmed",
            title: "Untrusted request reaches command execution adapter",
            vulnerability_class: "command-injection",
            severity: "high",
            explanation:
              "The request parameter is forwarded to the application's execution adapter without an intervening command/data separation control.",
            impact:
              "An attacker who controls the request value could alter the command interpreted by the execution adapter.",
            prerequisites: ["An attacker can control the handler request parameter."],
            limitations: ["Static analysis did not execute the adapter or reproduce live impact."],
            application_specific_remediation:
              "Change handler to map an allowlisted operation identifier to fixed argv entries and pass request data only as a separate argument; add a regression test that metacharacters remain inert.",
            structural_evidence: {
              identity: entrypoint,
              reachability: {
                explanation:
                  "The handler parameter is used directly as the argument to the execution adapter.",
                entrypoint,
                sink,
                path: [entrypoint, sink],
              },
              trust_boundary: {
                explanation:
                  "Data entering through the request parameter crosses into an execution-capable adapter call.",
                source: entrypoint,
                sink,
              },
              impact: {
                explanation:
                  "The execution adapter call is the effect-bearing location that can interpret attacker-controlled command data.",
                sink,
              },
            },
          },
        ],
        gaps: [],
      },
      raw_candidate_ids: [candidateId],
      coverage,
      inventory: fixture.inventory,
      corpus: fixture.corpus,
      provenance: provenance(fixture.bytes),
    });
    expect(ledger).toMatchObject({
      finding_count: 1,
      adjudication_gate: { status: "passed", host_demoted_confirmation_count: 0 },
      coverage: { completeness_gate: { status: "passed" } },
    });
    const promoted = ledger.canonical_candidates[0];
    if (promoted?.disposition !== "confirmed") throw new Error("finding was not promoted");
    expect(promoted.finding.evidence_revision.structural_evidence.identity).toEqual({
      path: "src/handler.ts",
      start_line: 1,
      end_line: 1,
      source_sha256: digest(source),
      cited_sha256: digest("export function handler(request: string) {"),
    });
    expect(promoted.finding.evidence_revision.structural_evidence.identity).not.toHaveProperty(
      "exact_quote"
    );
    expect(promoted.finding.exploitation).toEqual({
      status: "not_run",
      exploited: false,
      independent_reproduction_receipt_refs: [],
    });
  });

  it("promotes a source-bound PHP finding with qualified parser witnesses", () => {
    const source = [
      "<?php",
      "namespace App\\Security;",
      "class Runner {",
      "  public function execute($input) {",
      "    return system($input);",
      "  }",
      "}",
    ].join("\n");
    const fixture = sourceFixture({ "src/Runner.php": source });
    const candidateId = "primary_a:php-command-flow";
    const summaries = [
      analysis({
        profile: "primary_a",
        path: "src/Runner.php",
        quote: "<?php",
        candidateIds: [candidateId],
      }),
      analysis({ profile: "primary_b", path: "src/Runner.php", quote: "<?php" }),
    ];
    const coverage = buildScaCoverageLedgerV1({
      inventory: fixture.inventory,
      corpus: fixture.corpus,
      summaries,
    });
    const entrypoint = {
      path: "src/Runner.php",
      start_line: 4,
      end_line: 4,
      exact_quote: "  public function execute($input) {",
    };
    const sink = {
      path: "src/Runner.php",
      start_line: 5,
      end_line: 5,
      exact_quote: "    return system($input);",
    };
    const ledger = adjudicateScaReviewV2({
      review: {
        schema_version: 2,
        verdict: "PASS",
        coverage_assessments: credibleAssessments(coverage),
        canonical_candidates: [
          {
            canonical_id: "php-command-flow",
            raw_candidate_ids: [candidateId],
            disposition: "confirmed",
            title: "PHP request data reaches command execution",
            vulnerability_class: "command-injection",
            severity: "high",
            explanation:
              "The method forwards its input to the PHP command-execution function without command/data separation.",
            impact: "A caller controlling the method input could alter the interpreted command.",
            prerequisites: ["The caller controls the execute input."],
            limitations: ["Static analysis did not execute the PHP target."],
            application_specific_remediation:
              "Map allowed operations to fixed executable and argument arrays, and pass input only as a separate validated data argument.",
            structural_evidence: {
              identity: entrypoint,
              reachability: {
                explanation: "The method parameter is passed to the command-execution call.",
                entrypoint,
                sink,
                path: [entrypoint, sink],
              },
              trust_boundary: {
                explanation: "Method input crosses into an execution-capable PHP call.",
                source: entrypoint,
                sink,
              },
              impact: {
                explanation: "The system call is the effect-bearing location.",
                sink,
              },
            },
          },
        ],
        gaps: [],
      },
      raw_candidate_ids: [candidateId],
      coverage,
      inventory: fixture.inventory,
      corpus: fixture.corpus,
      provenance: provenance(fixture.bytes),
    });
    expect(ledger).toMatchObject({
      finding_count: 1,
      adjudication_gate: { status: "passed", host_demoted_confirmation_count: 0 },
      canonical_candidates: [
        {
          disposition: "confirmed",
          finding: {
            fingerprint: {
              symbol: "namespace:App\\Security/class:Runner/method:execute",
            },
            evidence_revision: {
              parser_id: "php-parser-3.7.0-php8.5",
              parser_language: "php",
            },
            exploitation: { status: "not_run", exploited: false },
          },
        },
      ],
    });
  });

  it("demotes an arbitrary safe constant that is cited for every evidence role and blocks release", () => {
    const source = "export const safe = 1;";
    const fixture = sourceFixture({ "src/safe.ts": source });
    const candidateId = "primary_a:safe-constant";
    const coverage = buildScaCoverageLedgerV1({
      inventory: fixture.inventory,
      corpus: fixture.corpus,
      summaries: [
        analysis({
          profile: "primary_a",
          path: "src/safe.ts",
          quote: source,
          candidateIds: [candidateId],
        }),
        analysis({ profile: "primary_b", path: "src/safe.ts", quote: source }),
      ],
    });
    const pointer = { path: "src/safe.ts", start_line: 1, end_line: 1, exact_quote: source };
    const ledger = adjudicateScaReviewV2({
      review: {
        schema_version: 2,
        verdict: "PASS",
        coverage_assessments: credibleAssessments(coverage),
        canonical_candidates: [
          {
            canonical_id: "safe-constant",
            raw_candidate_ids: [candidateId],
            disposition: "confirmed",
            title: "Model-asserted issue on a safe constant",
            vulnerability_class: "invented-impact",
            severity: "high",
            explanation: "The model asserted a vulnerability without effect-bearing source syntax.",
            impact:
              "The model asserted impact that the cited source does not structurally support.",
            prerequisites: [],
            limitations: ["The citation contains only a constant declaration."],
            application_specific_remediation: "Do not change this constant without real evidence.",
            structural_evidence: {
              identity: pointer,
              reachability: {
                explanation: "The model claimed this constant was both source and sink.",
                entrypoint: pointer,
                sink: pointer,
                path: [pointer, pointer],
              },
              trust_boundary: {
                explanation: "The model claimed an unsupported trust-boundary crossing.",
                source: pointer,
                sink: pointer,
              },
              impact: {
                explanation: "The model claimed unsupported adverse impact.",
                sink: pointer,
              },
            },
          },
        ],
        gaps: [],
      },
      raw_candidate_ids: [candidateId],
      coverage,
      inventory: fixture.inventory,
      corpus: fixture.corpus,
      provenance: provenance(fixture.bytes),
    });
    expect(ledger).toMatchObject({
      finding_count: 0,
      adjudication_gate: { status: "failed", host_demoted_confirmation_count: 1 },
      canonical_candidates: [
        {
          disposition: "inconclusive",
          demotion: { reason_code: "structural_evidence_insufficient" },
        },
      ],
    });
    expect(() =>
      buildScaReleaseProjectionV1({
        ledger,
        ledger_artifact_id: `art_${"9".repeat(64)}`,
        ledger_sha256: "9".repeat(64),
      })
    ).toThrow(/refuses host-demoted/u);
  });

  it("rejects noncanonical repository-relative finding paths", () => {
    expect(() => normalizeScaFindingPath("../src/runner.ts")).toThrow(/not canonical/u);
    expect(() => normalizeScaFindingPath("src\\runner.ts")).toThrow(/not canonical/u);
    expect(normalizeScaFindingPath("src/runner.ts")).toBe("src/runner.ts");
  });
});
