import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { parseScaP10NativeJson } from "../../orchestration/dist/sca/p10-native-tests.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import { buildHostStaticInventory } from "../../orchestration/dist/sca/ordinary-source.js";
import { ScaAnalysisToolsSchema } from "../../orchestration/dist/sca/ordinary-contracts.js";
import {
  runBoundedScaProcess,
  type ScaProcessRequestV1,
  type ScaProcessResultV1,
} from "../src/process.js";
import {
  createOrdinaryRuleLearning,
  type ScaRuleLearningRequest,
  type OrdinaryRuleLearningHost,
  type ScaRuleLearningRecord,
  type ScaRuleLearningProcessReceipt,
  type ScaRulePromotionRequest,
  type ScaRulePromotionResult,
  type ScaRuleRescanRequest,
  ScaRuleLearningOfflineValidationSchema,
} from "../src/ordinary-rule-learning.js";
import { publishRuleRelease } from "../src/ordinary-rule-learning-io.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const hash = (value: unknown) => sha256(canonicalJson(value));
const classes = [
  "vulnerable",
  "fixed",
  "negative_neighbor",
  "benign",
  "generalized",
  "retained_vulnerable",
  "held_out",
  "broader_regression",
  "performance",
] as const;
const nativeConfig = process.env.PENNY_SCA_RULE_LEARNING_NATIVE_CONFIG;
const nativeEvidence = process.env.PENNY_SCA_RULE_LEARNING_EVIDENCE;
function processResult(
  request: ScaProcessRequestV1,
  stdout: string,
  patch: Partial<ScaProcessResultV1> = {}
): ScaProcessResultV1 {
  const result: ScaProcessResultV1 = {
    schema_id: "penny.sca-process-result.v1",
    schema_version: 1,
    request_sha256: hash(request),
    status: "succeeded",
    exit_code: 0,
    signal: null,
    stdout,
    stderr: "",
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(""),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: 0,
    stdout_truncated: false,
    stderr_truncated: false,
    failure_code: "none",
    ...patch,
  };
  return {
    ...result,
    stdout_sha256: sha256(result.stdout),
    stdout_bytes: Buffer.byteLength(result.stdout),
    stderr_sha256: sha256(result.stderr),
    stderr_bytes: Buffer.byteLength(result.stderr),
  };
}
function fixture(language: "php" | "javascript" | "typescript" = "javascript", parent?: string) {
  const root = mkdtempSync(path.join(parent ?? tmpdir(), "ordinary-rule-learning-"));
  if (parent === undefined) roots.push(root);
  const source = path.join(root, "source"),
    work = path.join(root, "work"),
    namespace = path.join(root, "releases");
  for (const dir of [source, work, namespace]) mkdirSync(dir, { mode: 0o700 });
  const ruleId = `fixture.${language}.danger`,
    extension = language === "php" ? "php" : language === "javascript" ? "js" : "ts";
  const pattern = language === "php" ? "exec($X)" : "eval($X)",
    positive = language === "php" ? "exec($input);" : "eval(input);",
    negative = language === "php" ? "strlen($input);" : "String(input);";
  const rule = canonicalJson({
    rules: [
      {
        id: ruleId,
        languages: [language],
        message: "Inert source-only disposable rule",
        severity: "WARNING",
        pattern,
        metadata: { category: "correctness", technology: [language] },
      },
    ],
  });
  const rulesPath = path.join(root, "candidate.json"),
    baselinePath = path.join(root, "baseline.json");
  writeFileSync(rulesPath, rule, { flag: "wx", mode: 0o600 });
  writeFileSync(
    baselinePath,
    canonicalJson({
      rules: [
        {
          id: "fixture.baseline",
          languages: [language],
          message: "Disposable retained baseline rule",
          severity: "INFO",
          pattern: language === "php" ? "strlen($X)" : "String($X)",
        },
      ],
    }),
    {
      flag: "wx",
      mode: 0o600,
    }
  );
  const sourceText = `${language === "php" ? "<?php\n" : ""}${positive}\n`;
  writeFileSync(path.join(source, `handler.${extension}`), sourceText);
  const captured = buildHostStaticInventory({
    schema_version: 1,
    source_root: source,
    purpose: "Disposable source-only rule learning fixture, not vulnerability proof",
    scope: { include: [], exclude: [] },
    execution_mode: "static_only",
    model: "deepseek-flash",
  });
  const fixtures = classes.map((caseClass, i) => {
    const match = !["fixed", "negative_neighbor", "benign"].includes(caseClass);
    // Independent fixture oracle declared before scanner execution. Every file includes
    // a positive control; target assertion remains negative on fixed/benign/neighbor files.
    const target =
      language === "php"
        ? {
            vulnerable: positive,
            fixed: negative,
            negative_neighbor: "function neighbor($value) { return strlen($value); }",
            benign: 'strlen("constant");',
            generalized: "exec($other);",
            retained_vulnerable: "if ($input) { exec($input); }",
            held_out: "function held_out($value) { exec($value); }",
            broader_regression: "exec($input); strlen($input);",
            performance: "foreach ($values as $value) { exec($value); }",
          }[caseClass]
        : {
            vulnerable: positive,
            fixed: negative,
            negative_neighbor: "function neighbor(value) { return String(value); }",
            benign: 'String("constant");',
            generalized: "eval(other);",
            retained_vulnerable: "if (input) { eval(input); }",
            held_out: "function heldOut(value) { eval(value); }",
            broader_regression: "eval(input); String(input);",
            performance: "for (const value of values) { eval(value); }",
          }[caseClass];
    const text = `${language === "php" ? "<?php\n" : "// inert fixture\n"}// ruleid: ${ruleId}\n${positive}\n// ${match ? "ruleid" : "ok"}: ${ruleId}\n${target}\n`;
    return {
      id: `case-${i}`,
      case_class: caseClass,
      file_name: `${caseClass}.${extension}`,
      content_base64: Buffer.from(text).toString("base64"),
      content_sha256: sha256(text),
      control_lines: [3],
      baseline_matches:
        !match || caseClass === "broader_regression"
          ? [{ rule_id: "fixture.baseline", line: 5 }]
          : [],
      assertions: [{ line: 5, match }],
    };
  });
  const metachecks = canonicalJson({
    rules: ["test-only-metacheck", "independent-second-metacheck"].map((id) => ({
      id,
      languages: ["yaml"],
      pattern: 'message: ""',
      message: "test only",
      severity: "ERROR",
    })),
  });
  const metachecksPath = path.join(root, "metachecks.json");
  writeFileSync(metachecksPath, metachecks, { mode: 0o600 });
  const request: ScaRuleLearningRequest = {
    schema_version: 1,
    run_id: "disposable-rule-learning",
    source_snapshot_sha256: captured.sourceSnapshotSha256,
    source_corpus_sha256: sha256(captured.sourceCorpus),
    reconciliation_sha256: sha256("host-reconciled-fixture"),
    hypothesis_sha256: sha256("host-confirmed-fixture-hypothesis"),
    disposition_sha256: sha256("host-confirmed-fixture-disposition"),
    evidence_sha256: sha256("host-verified-fixture-evidence"),
    hypothesis_id: "fixture-hypothesis",
    root_cause:
      "Declared fixture oracle: dynamic sink is present; scanner detection alone does not prove a vulnerability.",
    evidence_pointers: [
      {
        path: `handler.${extension}`,
        start_line: 1,
        end_line: language === "php" ? 2 : 1,
        exact_quote: sourceText.trimEnd(),
      },
    ],
    baseline: {
      release_sha256: sha256("retained-disposable-baseline-release"),
      rules_path: baselinePath,
      rules_sha256: sha256(readFileSync(baselinePath)),
      rule_ids: ["fixture.baseline"],
    },
    tool: {
      executable: "/fixture-only/semgrep",
      sha256: sha256("fixture-only-tool"),
      version: "synthetic-only",
    },
    offline_validation: {
      python: {
        executable: "/fixture-only/python",
        sha256: sha256("test-python"),
        version: "test",
      },
      core: {
        executable: "/fixture-only/core",
        sha256: sha256("test-core"),
        version: "synthetic-only",
      },
      metachecks: {
        rules_path: metachecksPath,
        rules_sha256: sha256(metachecks),
        rule_ids: ["test-only-metacheck", "independent-second-metacheck"],
      },
    },
    candidate: {
      rule_id: ruleId,
      language,
      rules_path: rulesPath,
      rules_sha256: sha256(rule),
    },
    no_rule_reason: null,
    fixtures,
    fixture_truth_sha256: hash(fixtures),
    limits: {
      inactivity_ms: 30000,
      max_output_bytes: 1048576,
      max_file_bytes: 1048576,
      max_input_bytes: 8388608,
      max_memory_mb: 512,
      max_processes: 20,
      performance_bound_ms: 300000,
    },
  };
  const corpus = Buffer.from(captured.sourceCorpus),
    receipts: ScaRuleLearningProcessReceipt[] = [],
    records = new Map<string, ScaRuleLearningRecord>();
  const host: OrdinaryRuleLearningHost = {
    workRoot: work,
    // Test-only authority fixture, NOT production evidence sufficiency or isolation.
    async admitValidation(r, sha) {
      return {
        request_sha256: sha,
        decision: "allow",
        reconciliation_sha256: r.reconciliation_sha256,
        hypothesis_sha256: r.hypothesis_sha256,
        disposition_sha256: r.disposition_sha256,
        evidence_sha256: r.evidence_sha256,
        fixture_truth_sha256: r.fixture_truth_sha256,
        reason: "Host test fixture oracle independently predeclared; not campaign confirmation",
      };
    },
    async authorize() {
      return true;
    },
    async runOffline(invocation) {
      if (invocation.arguments.includes("-c")) return processResult(invocation, "");
      if (invocation.arguments.includes("-check_rules"))
        return processResult(
          invocation,
          `.\n${canonicalJson({ version: request.tool.version, results: [], errors: [], skipped_rules: [] })}`
        );
      if (invocation.arguments.includes("--validate"))
        return processResult(invocation, '{"errors":[]}');
      const config = invocation.arguments[invocation.arguments.indexOf("--config") + 1],
        file = invocation.arguments.at(-1);
      if (config === undefined || file === undefined) throw new Error("Missing fixture invocation");
      const isRescan = file.includes("/source/"),
        f = request.fixtures.find((entry) => entry.file_name === path.basename(file));
      const expected = isRescan
        ? [language === "php" ? 2 : 1]
        : f === undefined
          ? []
          : [...f.control_lines, ...f.assertions.filter((a) => a.match).map((a) => a.line)];
      if (invocation.arguments.includes("--test"))
        return processResult(
          invocation,
          canonicalJson({
            config_missing_tests: [],
            config_missing_fixtests: [],
            config_with_errors: [],
            results: {
              [config]: {
                checks: {
                  [ruleId]: {
                    passed: true,
                    matches: {
                      [realpathSync(file)]: {
                        expected_lines: expected,
                        reported_lines: expected,
                      },
                    },
                    errors: [],
                  },
                },
              },
            },
            fixtest_results: {},
          })
        );
      return processResult(
        invocation,
        canonicalJson({
          version: request.tool.version,
          results: [
            ...expected.map((line) => ({
              check_id: ruleId,
              path: file,
              start: { line },
              end: { line },
            })),
            ...(isRescan ? [] : (f?.baseline_matches ?? [])).map((m) => ({
              check_id: m.rule_id,
              path: file,
              start: { line: m.line },
              end: { line: m.line },
            })),
          ],
          errors: [],
          paths: { scanned: [file] },
          skipped_rules: [],
        }),
        {
          status: expected.length ? "nonzero_exit" : "succeeded",
          exit_code: expected.length ? 1 : 0,
          failure_code: expected.length ? "nonzero_exit" : "none",
        }
      );
    },
    async recordPrivate(receipt) {
      receipts.push(structuredClone(receipt));
    },
    async recordValidation(record) {
      records.set(record.result.result_sha256, structuredClone(record));
    },
    async readValidation(sha) {
      const record = records.get(sha);
      if (record === undefined) throw new Error("Missing exact owner record");
      return structuredClone(record);
    },
  };
  return {
    root,
    source,
    work,
    namespace,
    request,
    corpus,
    rule,
    rulesPath,
    baselinePath,
    receipts,
    records,
    host,
  };
}
function promoteRequest(
  w: ReturnType<typeof fixture>,
  validation: string
): ScaRulePromotionRequest {
  return {
    schema_version: 1,
    run_id: w.request.run_id,
    validation_sha256: validation,
    namespace: w.namespace,
    predecessor_release_sha256: w.request.baseline.release_sha256,
    successor_revision: 2,
    authority: {
      decision: "allow",
      authority_sha256: sha256("explicit-disposable-promotion-fixture-authority"),
      explicit_caller_authority: true,
    },
  };
}
function rescanRequest(
  w: ReturnType<typeof fixture>,
  promoted: ScaRulePromotionResult
): ScaRuleRescanRequest {
  if (promoted.release_path === null || promoted.release_sha256 === null)
    throw new Error("No promotion receipt");
  return {
    schema_version: 1,
    run_id: w.request.run_id,
    release_path: promoted.release_path,
    release_sha256: promoted.release_sha256,
    source_snapshot_sha256: w.request.source_snapshot_sha256,
    source_corpus_sha256: w.request.source_corpus_sha256,
    retained_baseline_sha256: w.request.baseline.release_sha256,
    predecessor_investigation_sha256: w.request.reconciliation_sha256,
    rescan_revision: 2,
    authority: {
      decision: "allow",
      authority_sha256: sha256("independently-requested-disposable-rescan-fixture-authority"),
      explicit_caller_authority: true,
    },
    limits: w.request.limits,
  };
}
async function validated() {
  const w = fixture(),
    api = createOrdinaryRuleLearning(w.host),
    result = await api.validate(w.request, w.corpus);
  expect(result.status).toBe("validated");
  return { w, api, result, request: promoteRequest(w, result.result_sha256) };
}
describe("ordinary empirical rule learning — closed host-only boundary", () => {
  it("runs full validation, native-shaped tests and scans; derives concrete assertions, time and unchanged baseline", async () => {
    const { w, result } = await validated();
    expect(w.receipts).toHaveLength(20);
    expect(w.records.size).toBe(1);
    expect(result.cases).toHaveLength(9);
    expect(result.cases.every((c) => c.status === "passed")).toBe(true);
    expect(
      result.cases
        .filter((c) => ["fixed", "negative_neighbor", "benign"].includes(c.case_class))
        .every((c) => c.assertions.every((a) => a.observed === false))
    ).toBe(true);
    expect(result.elapsed_ms).toBe(w.receipts.reduce((sum, r) => sum + r.elapsed_ms, 0));
    expect(sha256(readFileSync(w.baselinePath))).toBe(w.request.baseline.rules_sha256);
    expect(result.baseline_unchanged).toBe(true);
    expect(readdirSync(w.work)).toEqual([]);
    expect(readdirSync(w.namespace)).toEqual([]);
    for (const r of w.receipts) {
      expect(r.invocation.environment.some((e) => /TOKEN|KEY|CREDENTIAL/u.test(e.name))).toBe(
        false
      );
      expect(r.invocation.arguments).not.toContain("auto");
      expect(r.result.request_sha256).toBe(hash(r.invocation));
    }
  });
  it.each(["unknown_field", "invalid_limit", "fixture_path", "authority_in_json"])(
    "rejects closed request mutant %s before process execution",
    async (mode) => {
      const w = fixture(),
        execute = vi.spyOn(w.host, "runOffline");
      const input: unknown =
        mode === "unknown_field"
          ? { ...w.request, plugin: "x" }
          : mode === "invalid_limit"
            ? {
                ...w.request,
                limits: { ...w.request.limits, max_processes: 0 },
              }
            : mode === "fixture_path"
              ? {
                  ...w.request,
                  fixtures: [{ ...w.request.fixtures[0], file_name: "../escape.js" }],
                }
              : { ...w.request, admitted: true };
      await expect(createOrdinaryRuleLearning(w.host).validate(input, w.corpus)).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    }
  );
  it("requires host eligibility and independent fixture admission; no model label is authority", async () => {
    const w = fixture(),
      original = w.host.admitValidation,
      execute = vi.spyOn(w.host, "runOffline");
    w.host.admitValidation = async (r, s) => ({
      ...(await original(r, s)),
      decision: "deny",
    });
    expect((await createOrdinaryRuleLearning(w.host).validate(w.request, w.corpus)).status).toBe(
      "denied"
    );
    expect(execute).not.toHaveBeenCalled();
    w.host.admitValidation = async (r, s) => ({
      ...(await original(r, s)),
      evidence_sha256: sha256("foreign"),
    });
    expect((await createOrdinaryRuleLearning(w.host).validate(w.request, w.corpus)).status).toBe(
      "failed"
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it("records a genuine host-reviewed no-rule assessment without scanner or promotion effects", async () => {
    const w = fixture();
    w.request.candidate = null;
    delete w.request.offline_validation;
    w.request.fixtures = [];
    w.request.fixture_truth_sha256 = hash([]);
    w.request.no_rule_reason =
      "This stateful fixture claim depends on actor/session ordering absent from a single syntactic pattern; no defensible rule proposed.";
    const execute = vi.spyOn(w.host, "runOffline"),
      api = createOrdinaryRuleLearning(w.host),
      result = await api.validate(w.request, w.corpus);
    expect(result.status).toBe("not_feasible");
    expect(execute).not.toHaveBeenCalled();
    expect((await api.promote(promoteRequest(w, result.result_sha256))).status).toBe("denied");
  });
  it.each([
    "source",
    "snapshot",
    "pointer",
    "truth",
    "missing_case",
    "duplicate",
    "annotations",
    "budget",
    "rule_digest",
    "invalid_rule",
    "plugin",
    "baseline",
    "overlap",
  ])("fails safely on %s without invoking analyzer", async (mode) => {
    const w = fixture(),
      execute = vi.spyOn(w.host, "runOffline");
    let corpus = w.corpus;
    if (mode === "source") corpus = Buffer.from("foreign");
    if (mode === "snapshot") w.request.source_snapshot_sha256 = sha256("foreign");
    if (mode === "pointer")
      w.request.evidence_pointers[0] = {
        path: "../foreign",
        start_line: 1,
        end_line: 1,
        exact_quote: "foreign",
      };
    if (mode === "truth") w.request.fixture_truth_sha256 = sha256("foreign");
    if (mode === "missing_case") {
      w.request.fixtures.pop();
      w.request.fixture_truth_sha256 = hash(w.request.fixtures);
    }
    if (mode === "duplicate") {
      const first = w.request.fixtures[0];
      if (first === undefined) throw new Error();
      w.request.fixtures.push(first);
      w.request.fixture_truth_sha256 = hash(w.request.fixtures);
    }
    if (mode === "annotations") {
      const first = w.request.fixtures[0];
      if (first === undefined) throw new Error();
      first.assertions = [{ line: 2, match: true }];
      w.request.fixture_truth_sha256 = hash(w.request.fixtures);
    }
    if (mode === "budget") w.request.limits.max_processes = 1;
    if (mode === "rule_digest") writeFileSync(w.rulesPath, "changed");
    if (mode === "invalid_rule" || mode === "plugin") {
      const rule = mode === "invalid_rule" ? "not json" : '{"rules":[{"validators":[]}]}';
      writeFileSync(w.rulesPath, rule);
      if (w.request.candidate === null) throw new Error();
      w.request.candidate.rules_sha256 = sha256(rule);
    }
    if (mode === "baseline") writeFileSync(w.baselinePath, "changed");
    if (mode === "overlap") {
      if (w.request.candidate === null) throw new Error();
      w.request.candidate.rules_path = w.baselinePath;
    }
    const result = await createOrdinaryRuleLearning(w.host).validate(w.request, corpus);
    expect(result.status).toBe("failed");
    expect(execute).not.toHaveBeenCalled();
    expect(readdirSync(w.work)).toEqual([]);
  });
  it.each(["symlink_rule", "hardlink_rule", "symlink_parent", "symlink_baseline"])(
    "refuses linked inputs %s",
    async (mode) => {
      const w = fixture();
      if (mode === "hardlink_rule") linkSync(w.rulesPath, path.join(w.root, "alias.json"));
      else if (mode === "symlink_parent") {
        const dir = path.join(w.root, "linked");
        symlinkSync(w.root, dir);
        if (w.request.candidate === null) throw new Error();
        w.request.candidate.rules_path = path.join(dir, "candidate.json");
      } else {
        const file = mode === "symlink_rule" ? w.rulesPath : w.baselinePath;
        renameSync(file, `${file}.original`);
        symlinkSync(`${file}.original`, file);
      }
      const execute = vi.spyOn(w.host, "runOffline");
      expect((await createOrdinaryRuleLearning(w.host).validate(w.request, w.corpus)).status).toBe(
        "failed"
      );
      expect(execute).not.toHaveBeenCalled();
    }
  );
  it.each([
    "missed_positive",
    "missed_retained_baseline",
    "negative_overmatch",
    "empty_checks",
    "skipped",
    "bad_json",
    "duplicate_json",
    "wrong_version",
    "wrong_rule",
    "wrong_path",
    "validate_failure",
    "validate_exit0_empty",
    "receipt_drift",
    "time_limit",
    "output_limit",
    "cancelled",
    "cleanup_failed",
  ])("never validates synthetic adversary %s", async (mode) => {
    const w = fixture(),
      original = w.host.runOffline;
    w.host.runOffline = async (invocation, signal) => {
      const result = await original(invocation, signal),
        isValidate = invocation.arguments.includes("-check_rules"),
        isTest = invocation.arguments.includes("--test");
      if (mode === "receipt_drift") return { ...result, request_sha256: sha256("wrong") };
      if (mode === "validate_failure" && isValidate)
        return processResult(invocation, '{"errors":["metachecks unavailable"]}', {
          status: "nonzero_exit",
          exit_code: 2,
          failure_code: "nonzero_exit",
        });
      if (mode === "validate_exit0_empty" && isValidate) return processResult(invocation, "");
      if (isValidate) return result;
      if (mode === "time_limit")
        return processResult(invocation, result.stdout, {
          status: "timed_out",
          exit_code: null,
          failure_code: "timeout",
        });
      if (mode === "output_limit")
        return processResult(invocation, result.stdout, {
          status: "output_limit",
          stdout_truncated: true,
          failure_code: "output_limit",
        });
      if (mode === "cancelled")
        return processResult(invocation, result.stdout, {
          status: "cancelled",
          failure_code: "cancelled",
        });
      if (mode === "cleanup_failed")
        return processResult(invocation, result.stdout, {
          status: "spawn_failed",
          failure_code: "cleanup_failed",
        });
      if (mode === "empty_checks" && isTest) {
        const config = invocation.arguments[invocation.arguments.indexOf("--config") + 1];
        if (config === undefined) throw new Error("missing config");
        return processResult(
          invocation,
          canonicalJson({
            config_missing_tests: [],
            config_missing_fixtests: [],
            config_with_errors: [],
            results: { [config]: { checks: {} } },
            fixtest_results: {},
          })
        );
      }
      if (mode === "bad_json") return processResult(invocation, "not-json");
      if (mode === "duplicate_json")
        return processResult(invocation, '{"results":[],"results":[]}');
      if (isTest || invocation.arguments.includes("-c")) return result;
      const parsed = validateContract(
        Type.Object(
          {
            results: Type.Array(
              Type.Object(
                {
                  check_id: Type.String(),
                  start: Type.Object({ line: Type.Integer() }, { additionalProperties: true }),
                  end: Type.Object({ line: Type.Integer() }, { additionalProperties: true }),
                },
                { additionalProperties: true }
              )
            ),
          },
          { additionalProperties: true }
        ),
        JSON.parse(result.stdout),
        "Synthetic scan mutation"
      );
      let stdout = result.stdout;
      if (mode === "missed_positive") stdout = canonicalJson({ ...parsed, results: [] });
      if (mode === "missed_retained_baseline")
        stdout = canonicalJson({
          ...parsed,
          results: parsed.results.filter((r) => r.check_id !== "fixture.baseline"),
        });
      if (mode === "negative_overmatch")
        stdout = canonicalJson({
          ...parsed,
          results: [
            ...parsed.results,
            {
              check_id: w.request.candidate?.rule_id,
              path: invocation.arguments.at(-1),
              start: { line: 5 },
              end: { line: 5 },
            },
          ],
        });
      if (mode === "skipped") stdout = canonicalJson({ ...parsed, skipped_rules: ["skipped"] });
      if (mode === "wrong_version") stdout = canonicalJson({ ...parsed, version: "foreign" });
      if (mode === "wrong_rule")
        stdout = stdout.replaceAll(w.request.candidate?.rule_id ?? "missing", "other-rule");
      if (mode === "wrong_path")
        stdout = stdout.replaceAll(invocation.arguments.at(-1) ?? "missing", "/foreign.js");
      return processResult(invocation, stdout, {
        status: "nonzero_exit",
        exit_code: 1,
        failure_code: "nonzero_exit",
      });
    };
    const api = createOrdinaryRuleLearning(w.host),
      result = await api.validate(w.request, w.corpus);
    expect(result.status).not.toBe("validated");
    expect((await api.promote(promoteRequest(w, result.result_sha256))).status).toBe("denied");
    expect(readdirSync(w.namespace)).toEqual([]);
  });
  it("measures acceptance cost instead of trusting printed performance claims", async () => {
    const w = fixture();
    w.request.limits.performance_bound_ms = 1;
    const original = w.host.runOffline;
    w.host.runOffline = async (invocation, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return original(invocation, signal);
    };
    const result = await createOrdinaryRuleLearning(w.host).validate(w.request, w.corpus);
    expect(result.elapsed_ms).toBeGreaterThan(1);
    expect(result.performance_passed).toBe(false);
    expect(result.status).toBe("quarantined");
  });
  it.each([
    "capture",
    "owner",
    "cancel_before",
    "cancel_during",
    "fixture_drift",
    "rule_drift",
    "baseline_drift",
  ])("fails closed and cleans staging on %s", async (mode) => {
    const w = fixture(),
      controller = new AbortController(),
      original = w.host.runOffline;
    if (mode === "cancel_before") controller.abort();
    if (mode === "capture")
      w.host.recordPrivate = async () => {
        throw new Error("retention fault");
      };
    if (mode === "owner")
      w.host.recordValidation = async () => {
        throw new Error("owner fault");
      };
    w.host.runOffline = async (invocation, signal) => {
      const result = await original(invocation, signal);
      if (mode === "cancel_during") controller.abort();
      if (mode === "baseline_drift") writeFileSync(w.baselinePath, "changed");
      if (mode === "rule_drift")
        writeFileSync(path.join(invocation.cwd, "candidate.json"), "changed");
      if (mode === "fixture_drift") {
        const name = w.request.fixtures[0]?.file_name;
        if (name === undefined) throw new Error();
        writeFileSync(path.join(invocation.cwd, "fixtures", name), "changed");
      }
      return result;
    };
    const run = createOrdinaryRuleLearning(w.host).validate(w.request, w.corpus, {
      signal: controller.signal,
    });
    if (mode === "owner") await expect(run).rejects.toThrow("owner fault");
    else {
      const result = await run;
      expect(result.status).toBe("failed");
      if (mode === "baseline_drift") expect(result.baseline_unchanged).toBe(false);
    }
    expect(readdirSync(w.work)).toEqual([]);
  });
});
describe("ordinary immutable future-only promotion and separately admitted rescan", () => {
  it("creates content-addressed successor once, adopts replay, retains baseline and never silently rescans", async () => {
    const { w, api, result, request } = await validated(),
      count = w.receipts.length;
    const promotion = await api.promote(request);
    expect(promotion.status).toBe("promoted");
    expect(promotion.baseline_unchanged).toBe(true);
    expect(w.receipts).toHaveLength(count);
    if (promotion.release_path === null) throw new Error();
    const bytes = readFileSync(promotion.release_path);
    expect(sha256(bytes)).toBe(promotion.release_sha256);
    expect(path.basename(promotion.release_path)).toBe(`${sha256(bytes)}.json`);
    expect(await api.promote(request)).toMatchObject({
      ...promotion,
      status: "adopted",
    });
    expect(w.receipts).toHaveLength(count);
    const successor = rescanRequest(w, promotion),
      rescanned = await api.rescan(successor, w.corpus);
    expect(rescanned.status).toBe("completed");
    expect(rescanned.rescan_revision).toBe(2);
    expect(rescanned.findings).toHaveLength(1);
    expect(rescanned.reenter_investigation).toBe(true);
    expect(rescanned.retained_baseline_sha256).toBe(w.request.baseline.release_sha256);
    expect(w.receipts).toHaveLength(count + 1);
    expect(sha256(readFileSync(w.baselinePath))).toBe(w.request.baseline.rules_sha256);
    expect(readFileSync(promotion.release_path).equals(bytes)).toBe(true);
    expect(result.status).toBe("validated");
  });
  it("requires distinct explicit authority for each consequence", async () => {
    const { w, api, request } = await validated();
    expect(
      (
        await api.promote({
          ...request,
          authority: { ...request.authority, decision: "deny" },
        })
      ).status
    ).toBe("denied");
    expect(readdirSync(w.namespace)).toEqual([]);
    w.host.authorize = async (op) => op === "promote";
    const promoted = await api.promote(request),
      count = w.receipts.length;
    expect((await api.rescan(rescanRequest(w, promoted), w.corpus)).status).toBe("denied");
    expect(w.receipts).toHaveLength(count);
  });
  it("adopts same concurrent intent and conflicts on another immutable successor", async () => {
    const { w, api, request } = await validated();
    const outcomes = await Promise.all([api.promote(request), api.promote(request)]);
    expect(outcomes.map((r) => r.status).sort()).toEqual(["adopted", "promoted"]);
    expect(
      (
        await api.promote({
          ...request,
          authority: {
            ...request.authority,
            authority_sha256: sha256("other-intent"),
          },
        })
      ).status
    ).toBe("conflict");
    expect(readdirSync(w.namespace)).toHaveLength(1);
  });
  it.each(["before_publish", "after_publish"])(
    "recovers atomic publication fault %s without rewriting predecessor",
    async (boundary) => {
      const { w, api, request } = await validated();
      const failed = await api.promote(request, {}, (at) => {
        if (at === boundary) throw new Error("simulated crash");
      });
      expect(failed.status).toBe("failed");
      expect(readdirSync(w.namespace).some((name) => name.startsWith(".pending"))).toBe(false);
      expect((await api.promote(request)).status).toBe(
        boundary === "before_publish" ? "promoted" : "adopted"
      );
      expect(sha256(readFileSync(w.baselinePath))).toBe(w.request.baseline.rules_sha256);
    }
  );
  it("refuses corrupted raw validation evidence even after summary is rehashed", async () => {
    const { w, api, result, request } = await validated(),
      record = w.records.get(result.result_sha256);
    if (record === undefined) throw new Error();
    const raw = record.receipts[0];
    if (raw === undefined) throw new Error();
    raw.result.stdout = "forged";
    record.result.private_receipts_sha256 = hash(record.receipts);
    expect((await api.promote(request)).status).toBe("failed");
    expect(readdirSync(w.namespace)).toEqual([]);
  });
  it.each([
    "rule_drift",
    "baseline_drift",
    "namespace_link",
    "world_writable",
    "input_overlap",
    "cancel",
  ])("refuses unsafe promotion %s", async (mode) => {
    const { w, api, request } = await validated();
    let control = {};
    if (mode === "rule_drift") writeFileSync(w.rulesPath, "changed");
    if (mode === "baseline_drift") writeFileSync(w.baselinePath, "changed");
    if (mode === "namespace_link") {
      const alias = path.join(w.root, "alias");
      symlinkSync(w.namespace, alias);
      request.namespace = alias;
    }
    if (mode === "world_writable") chmodSync(w.namespace, 0o777);
    if (mode === "input_overlap") request.namespace = w.root;
    if (mode === "cancel") control = { signal: AbortSignal.abort() };
    expect(["failed", "denied"]).toContain((await api.promote(request, control)).status);
    expect(readdirSync(w.namespace)).toEqual([]);
  });
  it("retains uncertain committed release, refuses tampering, and does not repair it on replay", async () => {
    const { w, api, request } = await validated(),
      promoted = await api.promote(request);
    if (promoted.release_path === null) throw new Error();
    renameSync(promoted.release_path, `${promoted.release_path}.original`);
    writeFileSync(promoted.release_path, "tampered", {
      flag: "wx",
      mode: 0o600,
    });
    expect((await api.promote(request)).status).toBe("conflict");
    expect((await api.rescan(rescanRequest(w, promoted), w.corpus)).status).toBe("failed");
    expect(readFileSync(promoted.release_path, "utf8")).toBe("tampered");
  });
  it.each(["lineage", "corpus", "symlink", "output_limit", "bad_path", "cancel"])(
    "refuses rescan mutant %s without replacing baseline",
    async (mode) => {
      const { w, api, request } = await validated(),
        promoted = await api.promote(request),
        successor = rescanRequest(w, promoted);
      let corpus = w.corpus,
        control = {};
      if (mode === "lineage") successor.retained_baseline_sha256 = sha256("foreign");
      if (mode === "corpus") corpus = Buffer.from("foreign");
      if (mode === "symlink") {
        const alias = path.join(w.root, "alias.json");
        symlinkSync(successor.release_path, alias);
        successor.release_path = alias;
      }
      if (mode === "cancel") control = { signal: AbortSignal.abort() };
      if (mode === "output_limit" || mode === "bad_path") {
        const original = w.host.runOffline;
        w.host.runOffline = async (invocation, signal) => {
          const result = await original(invocation, signal);
          return mode === "output_limit"
            ? {
                ...result,
                status: "output_limit",
                stdout_truncated: true,
                failure_code: "output_limit",
              }
            : processResult(
                invocation,
                result.stdout.replaceAll(invocation.arguments.at(-1) ?? "missing", "/escape.js"),
                {
                  status: "nonzero_exit",
                  exit_code: 1,
                  failure_code: "nonzero_exit",
                }
              );
        };
      }
      expect((await api.rescan(successor, corpus, control)).status).toBe("failed");
      expect(sha256(readFileSync(w.baselinePath))).toBe(w.request.baseline.rules_sha256);
      expect(readdirSync(w.work)).toEqual([]);
    }
  );
  it("appends a separately authorized rollback successor without changing either retained release", async () => {
    const { w, api, request } = await validated(),
      first = await api.promote(request);
    if (first.release_path === null || first.release_sha256 === null)
      throw new Error("missing first release");
    const before = readFileSync(first.release_path);
    const rollback = {
      schema_version: 1,
      run_id: w.request.run_id,
      namespace: w.namespace,
      predecessor_release_path: first.release_path,
      predecessor_release_sha256: first.release_sha256,
      restore_release_path: first.release_path,
      restore_release_sha256: first.release_sha256,
      successor_revision: 3,
      authority: {
        decision: "allow",
        authority_sha256: sha256("separate rollback authority fixture"),
        explicit_caller_authority: true,
      },
      limits: w.request.limits,
    };
    const restored = await api.rollback(rollback);
    expect(restored.status).toBe("promoted");
    expect(restored.release_sha256).not.toBe(first.release_sha256);
    expect((await api.rollback(rollback)).status).toBe("adopted");
    expect(readFileSync(first.release_path).equals(before)).toBe(true);
    expect(sha256(readFileSync(w.baselinePath))).toBe(w.request.baseline.rules_sha256);
    expect((await api.rollback({ ...rollback, successor_revision: 2 })).status).toBe("denied");
    expect(
      (
        await api.rollback({
          ...rollback,
          authority: { ...rollback.authority, decision: "deny" },
        })
      ).status
    ).toBe("denied");
    w.host.authorize = async () => false;
    expect((await api.rollback(rollback)).status).toBe("denied");
  });
  it("cancellation at the atomic publish boundary leaves no successor; baseline drift after commit is non-positive", async () => {
    const { w, api, request } = await validated(),
      controller = new AbortController();
    const cancelled = await api.promote(request, { signal: controller.signal }, (boundary) => {
      if (boundary === "before_publish") controller.abort();
    });
    expect(cancelled.status).toBe("failed");
    expect(readdirSync(w.namespace)).toEqual([]);
    const drifted = await api.promote(request, {}, (boundary) => {
      if (boundary === "after_publish") writeFileSync(w.baselinePath, "external fixture drift");
    });
    expect(drifted.status).toBe("failed");
    expect(drifted.baseline_unchanged).toBe(false);
    expect(readdirSync(w.namespace)).toHaveLength(1);
  });
  it("does not overwrite an unexpected successor directory or orphan pending files", () => {
    const w = fixture(),
      slot = sha256("slot"),
      target = path.join(w.namespace, `successor-${slot}`);
    mkdirSync(target);
    writeFileSync(path.join(target, "foreign"), "keep");
    expect(
      publishRuleRelease({
        namespace: w.namespace,
        slot,
        content: Buffer.from("candidate"),
      }).status
    ).toBe("conflict");
    expect(readFileSync(path.join(target, "foreign"), "utf8")).toBe("keep");
    const orphan = path.join(w.namespace, ".pending-old");
    mkdirSync(orphan);
    writeFileSync(path.join(orphan, "foreign"), "keep");
    expect(
      publishRuleRelease({
        namespace: w.namespace,
        slot: sha256("another"),
        content: Buffer.from("new"),
      }).status
    ).toBe("promoted");
    expect(readFileSync(path.join(orphan, "foreign"), "utf8")).toBe("keep");
  });
});

describe("required full offline validation contract — synthetic boundary mutants", () => {
  it("quarantines CLI-only empty-errors validation with a precise gap, never breaking no-rule", async () => {
    const w = fixture();
    delete w.request.offline_validation;
    w.request.limits.max_processes = 19;
    const api = createOrdinaryRuleLearning(w.host),
      result = await api.validate(w.request, w.corpus);
    expect(w.receipts).toHaveLength(19);
    expect(result.cases.every((c) => c.status === "passed")).toBe(true);
    expect(result.status).toBe("quarantined");
    expect(result.validation_passed).toBe(false);
    expect(result.reasons).toContain(
      "full_offline_validation_pins_required_schema_core_entire_admitted_metachecks"
    );
    expect((await api.promote(promoteRequest(w, result.result_sha256))).status).toBe("denied");
    expect(readdirSync(w.namespace)).toEqual([]);
    // Simulate a genuine old-version record, which was promotable with exactly these 19 receipts.
    const record = w.records.get(result.result_sha256);
    if (record === undefined) throw new Error("Missing retained legacy record");
    const { result_sha256, ...body } = {
      ...result,
      status: "validated" as const,
      reasons: ["all_declared_assertions_passed"],
      validation_passed: true,
    };
    expect(result_sha256).toBe(result.result_sha256);
    record.result = { ...body, result_sha256: hash(body) };
    w.records.set(record.result.result_sha256, record);
    expect((await api.promote(promoteRequest(w, record.result.result_sha256))).status).toBe(
      "denied"
    );
    expect(readdirSync(w.namespace)).toEqual([]);
  });
  it.each([
    "missing_schema",
    "missing_metacheck",
    "missing_progress",
    "check_skipped",
    "zero_exit_error",
    "schema_nonzero",
    "schema_unsigned",
    "input_pin",
    "removed_rule",
    "fixture_truth",
    "source",
    "unsigned_admission",
  ])("rechecks full evidence before both publication and immutable adoption: %s", async (mode) => {
    const { w, api, result, request } = await validated();
    const record = w.records.get(result.result_sha256);
    if (record === undefined || record.request.offline_validation === undefined)
      throw new Error("Missing record");
    const approved = structuredClone(record.request);
    // Source/evidence and the complete manifest belong to the existing host, not the producer.
    const admission = w.host.admitValidation;
    w.host.admitValidation = async (r, digest) => ({
      ...(await admission(r, digest)),
      decision: hash(r) === hash(approved) ? "allow" : "deny",
    });
    const promoted = await api.promote(request);
    expect(promoted.status).toBe("promoted");
    if (promoted.release_path === null) throw new Error("Missing release");
    const releaseBytes = readFileSync(promoted.release_path),
      before = readdirSync(w.namespace);
    const core = record.receipts.find((r) => r.kind === "validate"),
      schema = record.receipts.find((r) => r.kind === "validate_schema");
    if (core === undefined || schema === undefined) throw new Error("Missing stages");
    if (mode === "missing_schema") record.receipts = record.receipts.filter((r) => r !== schema);
    if (mode === "missing_metacheck") record.receipts = record.receipts.filter((r) => r !== core);
    if (mode === "missing_progress")
      core.result = processResult(core.invocation, core.result.stdout.slice(2));
    if (mode === "check_skipped")
      core.result = processResult(
        core.invocation,
        `.\n${canonicalJson({ version: w.request.tool.version, results: [], errors: [], skipped_rules: ["omitted"] })}`
      );
    if (mode === "zero_exit_error")
      core.result = processResult(
        core.invocation,
        `.\n${canonicalJson({ version: w.request.tool.version, results: [], errors: ["failure"], skipped_rules: [] })}`
      );
    if (mode === "schema_nonzero")
      schema.result = processResult(schema.invocation, "", {
        status: "nonzero_exit",
        exit_code: 2,
        failure_code: "nonzero_exit",
      });
    if (mode === "schema_unsigned") schema.result.request_sha256 = sha256("unbound result");
    if (mode === "input_pin")
      record.request.offline_validation.core.sha256 = sha256("different core");
    if (mode === "removed_rule") record.request.offline_validation.metachecks.rule_ids.pop();
    if (mode === "fixture_truth") record.request.fixture_truth_sha256 = sha256("unapproved truth");
    if (mode === "source") record.request.source_corpus_sha256 = sha256("unapproved source");
    if (mode === "unsigned_admission")
      record.admission.request_sha256 = sha256("not host admitted");
    // Rehashed producer summaries are not authority. Replay must inspect raw evidence too.
    record.result.private_receipts_sha256 = hash(record.receipts);
    expect(["denied", "failed"]).toContain((await api.promote(request)).status);
    expect(readdirSync(w.namespace)).toEqual(before);
    expect(readFileSync(promoted.release_path).equals(releaseBytes)).toBe(true);
    const calls = vi.spyOn(w.host, "runOffline");
    expect(["denied", "failed"]).toContain(
      (await api.rescan(rescanRequest(w, promoted), w.corpus)).status
    );
    expect(calls).not.toHaveBeenCalled();
    // Also refuse a fresh successor slot; never write a new external release after failed replay.
    expect(["denied", "failed"]).toContain(
      (await api.promote({ ...request, successor_revision: 3 })).status
    );
    expect(readdirSync(w.namespace)).toEqual(before);
  });
  it.each(["source", "fixture_truth", "input_pin", "removed_rule"])(
    "refuses fully readdressed but unapproved retained inputs (legacy replay would promote): %s",
    async (mode) => {
      const { w, api, result } = await validated();
      const record = w.records.get(result.result_sha256);
      if (record === undefined || record.request.offline_validation === undefined)
        throw new Error("Missing record");
      const approved = structuredClone(record.request),
        admit = w.host.admitValidation;
      w.host.admitValidation = async (r, digest) => ({
        ...(await admit(r, digest)),
        decision: hash(r) === hash(approved) ? "allow" : "deny",
      });
      if (mode === "source") record.request.source_corpus_sha256 = sha256("foreign source");
      if (mode === "fixture_truth") record.request.fixture_truth_sha256 = sha256("foreign truth");
      const offline = record.request.offline_validation;
      if (mode === "input_pin") {
        offline.core.sha256 = sha256("unapproved executable");
        for (const receipt of record.receipts)
          if (receipt.kind === "validate")
            receipt.invocation.executable_sha256 = offline.core.sha256;
      }
      if (mode === "removed_rule") {
        const bundle = validateContract(
          Type.Object({ rules: Type.Array(Type.Unknown()) }),
          JSON.parse(readFileSync(offline.metachecks.rules_path, "utf8")),
          "Original test manifest"
        );
        const bytes = canonicalJson({ rules: bundle.rules.slice(1) });
        writeFileSync(offline.metachecks.rules_path, bytes);
        offline.metachecks.rules_sha256 = sha256(bytes);
        offline.metachecks.rule_ids = offline.metachecks.rule_ids.slice(1);
        for (const receipt of record.receipts)
          if (receipt.kind === "validate_schema") {
            receipt.invocation.arguments[receipt.invocation.arguments.length - 1] =
              offline.metachecks.rule_ids.join(",");
          }
      }
      // All producer-computable hashes agree. Only trusted approval of the original exact
      // source/truth/tool/whole manifest can reject this; a digest is not a signature.
      const requestSha = hash(record.request);
      record.admission.request_sha256 = requestSha;
      record.admission.fixture_truth_sha256 = record.request.fixture_truth_sha256;
      for (const receipt of record.receipts) {
        receipt.request_sha256 = requestSha;
        receipt.result.request_sha256 = hash(receipt.invocation);
      }
      const { result_sha256, ...body } = {
        ...record.result,
        request_sha256: requestSha,
        private_receipts_sha256: hash(record.receipts),
      };
      expect(result_sha256).toBe(result.result_sha256);
      record.result = { ...body, result_sha256: hash(body) };
      w.records.set(record.result.result_sha256, record);
      const promote = promoteRequest(w, record.result.result_sha256),
        calls = vi.spyOn(w.host, "runOffline");
      expect((await api.promote(promote)).status).toBe("denied");
      expect(calls).not.toHaveBeenCalled();
      expect(readdirSync(w.namespace)).toEqual([]);
    }
  );
  it("rejects selective removal against the independent approved manifest even if bytes and IDs agree", async () => {
    const w = fixture(),
      offline = w.request.offline_validation;
    if (offline === undefined) throw new Error("Missing pins");
    const approved = structuredClone(offline),
      original = w.host.admitValidation;
    const full = readFileSync(offline.metachecks.rules_path, "utf8");
    const pack = validateContract(
      Type.Object({ rules: Type.Array(Type.Unknown()) }),
      JSON.parse(full),
      "Test pack"
    );
    const subset = canonicalJson({ rules: pack.rules.slice(1) });
    writeFileSync(offline.metachecks.rules_path, subset);
    offline.metachecks.rules_sha256 = sha256(subset);
    offline.metachecks.rule_ids = offline.metachecks.rule_ids.slice(1);
    w.host.admitValidation = async (r, digest) => ({
      ...(await original(r, digest)),
      decision: hash(r.offline_validation) === hash(approved) ? "allow" : "deny",
    });
    const run = vi.spyOn(w.host, "runOffline"),
      api = createOrdinaryRuleLearning(w.host);
    const result = await api.validate(w.request, w.corpus);
    expect(result.status).toBe("denied");
    expect(run).not.toHaveBeenCalled();
    expect((await api.promote(promoteRequest(w, result.result_sha256))).status).toBe("denied");
    expect(readdirSync(w.namespace)).toEqual([]);
  });
  it("binds separate schema/core receipts and replays exact approved pins during promotion", async () => {
    const w = fixture(),
      api = createOrdinaryRuleLearning(w.host);
    const result = await api.validate(w.request, w.corpus);
    expect(result.status).toBe("validated");
    expect(w.receipts).toHaveLength(20);
    expect(w.receipts[0]?.kind).toBe("validate_schema");
    expect(w.receipts[1]?.invocation.arguments).toContain("-check_rules");
    expect(w.receipts[1]?.invocation.arguments.some((a) => a.endsWith("candidate.yaml"))).toBe(
      true
    );
    expect((await api.promote(promoteRequest(w, result.result_sha256))).status).toBe("promoted");
    expect(readdirSync(w.work)).toEqual([]);
  });
  it.each([
    "schema_failure",
    "core_error_exit_zero",
    "core_no_progress",
    "core_wrong_version",
    "schema_stderr",
    "missing_core_field",
    "duplicate_progress",
    "metacheck_mutation",
    "captured_mutation",
    "empty_pack",
    "wrong_ids",
    "budget",
    "extra_schema",
  ])("refuses offline validation mutant %s", async (mode) => {
    const w = fixture(),
      original = w.host.runOffline;
    const offline = w.request.offline_validation;
    if (offline === undefined) throw new Error();
    if (mode === "budget") w.request.limits.max_processes = 19;
    if (mode === "empty_pack") {
      writeFileSync(offline.metachecks.rules_path, '{"rules":[]}');
      offline.metachecks.rules_sha256 = sha256('{"rules":[]}');
    }
    if (mode === "wrong_ids") offline.metachecks.rule_ids = ["foreign"];
    w.host.runOffline = async (invocation, signal) => {
      const result = await original(invocation, signal);
      if (invocation.arguments.includes("-c")) {
        if (mode === "schema_failure")
          return processResult(invocation, "", {
            status: "nonzero_exit",
            exit_code: 2,
            failure_code: "nonzero_exit",
          });
        if (mode === "schema_stderr")
          return processResult(invocation, "", { stderr: "incomplete" });
        if (mode === "metacheck_mutation") writeFileSync(offline.metachecks.rules_path, "changed");
        if (mode === "captured_mutation") {
          chmodSync(path.join(invocation.cwd, "metachecks.json"), 0o600);
          writeFileSync(path.join(invocation.cwd, "metachecks.json"), "changed");
        }
      }
      if (!invocation.arguments.includes("-check_rules")) return result;
      if (mode === "core_error_exit_zero")
        return processResult(
          invocation,
          '.\n{"version":"synthetic-only","results":[],"errors":["metacheck"],"skipped_rules":[]}'
        );
      if (mode === "core_no_progress") return processResult(invocation, result.stdout.slice(2));
      if (mode === "core_wrong_version")
        return processResult(invocation, result.stdout.replace("synthetic-only", "foreign"));
      if (mode === "missing_core_field") return processResult(invocation, '.\n{"errors":[]}');
      if (mode === "duplicate_progress") return processResult(invocation, ".\n" + result.stdout);
      return result;
    };
    const api = createOrdinaryRuleLearning(w.host),
      result = await api.validate(w.request, w.corpus);
    if (mode === "extra_schema") {
      const record = w.records.get(result.result_sha256);
      if (record === undefined || record.receipts[0] === undefined) throw new Error();
      record.receipts.push(record.receipts[0]);
    } else expect(result.status).not.toBe("validated");
    expect((await api.promote(promoteRequest(w, result.result_sha256))).status).not.toBe(
      "promoted"
    );
    expect(readdirSync(w.work)).toEqual([]);
  });
  it("refuses changed retained metachecks at promotion after successful validation", async () => {
    const w = fixture(),
      api = createOrdinaryRuleLearning(w.host),
      result = await api.validate(w.request, w.corpus);
    const offline = w.request.offline_validation;
    if (offline === undefined) throw new Error();
    writeFileSync(offline.metachecks.rules_path, "changed");
    expect((await api.promote(promoteRequest(w, result.result_sha256))).status).toBe("failed");
  });
});

describe.skipIf(nativeConfig === undefined || nativeEvidence === undefined)(
  "ordinary empirical learning — installed Semgrep, no target execution",
  () => {
    it.each(["php", "javascript", "typescript"] as const)(
      "retains actual validation/test/scan observations for %s",
      async (language) => {
        if (nativeConfig === undefined || nativeEvidence === undefined)
          throw new Error("Explicit caller native paths required");
        const config = validateContract(
          Type.Object(
            {
              tools: ScaAnalysisToolsSchema,
              evidence_directory: Type.String(),
              offline_validation: Type.Optional(ScaRuleLearningOfflineValidationSchema),
            },
            { additionalProperties: false }
          ),
          JSON.parse(readFileSync(nativeConfig, "utf8")),
          "Caller native configuration"
        );
        const scanner = config.tools.semgrep;
        if (scanner === undefined) throw new Error("Semgrep missing");
        const w = fixture(language, nativeEvidence);
        w.request.tool = scanner.tool;
        if (config.offline_validation !== undefined)
          w.request.offline_validation = config.offline_validation;
        else {
          delete w.request.offline_validation;
          w.request.limits.max_processes = 19;
        }
        const authorized = new Set<string>();
        w.host.authorize = async (operation, request, digest) =>
          digest === hash(request) && authorized.has(`${operation}:${digest}`);
        expect(sha256(readFileSync(scanner.tool.executable))).toBe(scanner.tool.sha256);
        w.host.runOffline = (invocation, signal) => runBoundedScaProcess(invocation, signal);
        w.host.recordPrivate = async (receipt) => {
          w.receipts.push(receipt);
          const index = w.receipts.length - 1;
          writeFileSync(path.join(w.root, `${index}.receipt.json`), canonicalJson(receipt), {
            flag: "wx",
            mode: 0o600,
          });
          writeFileSync(path.join(w.root, `${index}.stdout`), receipt.result.stdout, {
            flag: "wx",
            mode: 0o600,
          });
          writeFileSync(path.join(w.root, `${index}.stderr`), receipt.result.stderr, {
            flag: "wx",
            mode: 0o600,
          });
        };
        const previous = w.host.recordValidation;
        w.host.recordValidation = async (record) => {
          await previous(record);
          writeFileSync(
            path.join(w.root, `${record.result.result_sha256}.validation-record.json`),
            canonicalJson(record),
            {
              flag: "wx",
              mode: 0o600,
            }
          );
        };
        const baselineBefore = readFileSync(w.baselinePath),
          api = createOrdinaryRuleLearning(w.host),
          result = await api.validate(w.request, w.corpus);
        writeFileSync(path.join(w.root, "source-corpus.bin"), w.corpus, {
          flag: "wx",
          mode: 0o600,
        });
        writeFileSync(path.join(w.root, "result.json"), canonicalJson(result), {
          flag: "wx",
          mode: 0o600,
        });
        expect(w.receipts).toHaveLength(config.offline_validation === undefined ? 19 : 20);
        expect(w.receipts.every((r) => existsSync(r.invocation.cwd) === false)).toBe(true);
        // CLI-only compatibility is always quarantined, even with successful empty-errors output.
        expect(result.status).toBe(
          config.offline_validation === undefined ? "quarantined" : "validated"
        );
        expect(result.performance_passed).toBe(true);
        const promotionRequest = promoteRequest(w, result.result_sha256);
        const beforePromotion = w.receipts.length;
        expect((await api.promote(promotionRequest)).status).toBe("denied");
        authorized.add(`promote:${hash(promotionRequest)}`);
        expect(result.cases.every((c) => c.status === "passed")).toBe(true);
        expect(result.cases.every((c) => c.baseline_matches_passed)).toBe(true);
        const promotion = await api.promote(promotionRequest);
        expect(w.receipts).toHaveLength(beforePromotion);
        writeFileSync(path.join(w.root, "promotion-result.json"), canonicalJson(promotion), {
          flag: "wx",
          mode: 0o600,
        });
        if (result.validation_passed) {
          expect(promotion.status).toBe("promoted");
          const successor = rescanRequest(w, promotion);
          expect((await api.rescan(successor, w.corpus)).status).toBe("denied");
          expect(w.receipts).toHaveLength(beforePromotion);
          authorized.add(`rescan:${hash(successor)}`);
          writeFileSync(path.join(w.root, "native-rescan-request.json"), canonicalJson(successor), {
            flag: "wx",
            mode: 0o600,
          });
          const rescan = await api.rescan(successor, w.corpus);
          writeFileSync(path.join(w.root, "native-rescan-result.json"), canonicalJson(rescan), {
            flag: "wx",
            mode: 0o600,
          });
          expect(rescan.status).toBe("completed");
          expect(rescan.findings.length).toBeGreaterThan(0);
          expect(rescan.reenter_investigation).toBe(true);
          expect(rescan.release_sha256).toBe(promotion.release_sha256);
          expect(rescan.predecessor_investigation_sha256).toBe(w.request.reconciliation_sha256);
          expect(rescan.rescan_revision).toBe(2);
          expect((await api.promote(promotionRequest)).status).toBe("adopted");
        } else {
          expect(promotion.status).toBe("denied");
          expect(readdirSync(w.namespace)).toEqual([]);
        }
        expect(readFileSync(w.baselinePath).equals(baselineBefore)).toBe(true);
        if (language === "javascript" && config.offline_validation !== undefined) {
          const originalRule = readFileSync(w.rulesPath);
          for (const [name, pattern, message] of [
            ["false_negative", 'eval("not-the-fixture")', "Disposable missed-positive candidate"],
            ["overmatch", "$F($X)", "Disposable overmatching candidate"],
            ["invalid", "(", "Disposable invalid candidate"],
            ["metacheck", "eval($X)", "bad\nmessage"],
          ] as const) {
            if (w.request.candidate === null) throw new Error("missing candidate");
            const bytes = canonicalJson({
              rules: [
                {
                  id: w.request.candidate.rule_id,
                  languages: [language],
                  severity: "WARNING",
                  pattern,
                  message,
                  metadata: { category: "correctness", technology: [language] },
                },
              ],
            });
            writeFileSync(w.rulesPath, bytes);
            w.request.candidate.rules_sha256 = sha256(bytes);
            const rejected = await api.validate(w.request, w.corpus);
            expect(rejected.status).toBe("quarantined");
            if (name === "metacheck") {
              expect(rejected.validation_passed).toBe(false);
              expect(rejected.cases.every((c) => c.status === "passed")).toBe(true);
              const raw = w.receipts.find(
                (r) => r.request_sha256 === hash(w.request) && r.kind === "validate"
              );
              expect(raw?.result.stdout).toContain("multi-line message");
            }
            const attempt = promoteRequest(w, rejected.result_sha256);
            authorized.add(`promote:${hash(attempt)}`);
            expect((await api.promote(attempt)).status).toBe("denied");
            writeFileSync(
              path.join(w.root, `${name}.learning-result.json`),
              canonicalJson(rejected),
              { flag: "wx", mode: 0o600 }
            );
            expect(readFileSync(w.baselinePath).equals(baselineBefore)).toBe(true);
            expect(readdirSync(w.work)).toEqual([]);
          }
          writeFileSync(w.rulesPath, originalRule);
        }
        for (const [name, pattern, fixtureClass] of [
          [
            "missed_positive",
            language === "php" ? 'exec("not-the-fixture")' : 'eval("not-the-fixture")',
            "vulnerable",
          ],
          ["negative_overmatch", "$F($X)", "benign"],
          ["invalid_pattern", "(", "vulnerable"],
        ] as const) {
          const configPath = path.join(w.root, `${name}.json`),
            targetFixture = w.request.fixtures.find((f) => f.case_class === fixtureClass);
          if (targetFixture === undefined || w.request.candidate === null)
            throw new Error("missing diagnostic fixture");
          const targetPath = path.join(w.root, targetFixture.file_name);
          if (!existsSync(targetPath))
            writeFileSync(targetPath, Buffer.from(targetFixture.content_base64, "base64"), {
              flag: "wx",
              mode: 0o600,
            });
          writeFileSync(
            configPath,
            canonicalJson({
              rules: [
                {
                  id: w.request.candidate.rule_id,
                  languages: [language],
                  message: "Disposable negative diagnostic",
                  severity: "WARNING",
                  pattern,
                },
              ],
            }),
            { flag: "wx", mode: 0o600 }
          );
          const invocation: ScaProcessRequestV1 = {
            schema_id: "penny.sca-process-request.v1",
            schema_version: 1,
            executable: scanner.tool.executable,
            executable_sha256: scanner.tool.sha256,
            cwd: w.root,
            environment: [
              { name: "HOME", value: w.root },
              { name: "PATH", value: `${path.dirname(scanner.tool.executable)}:/usr/bin:/bin` },
              { name: "XDG_CACHE_HOME", value: w.root },
              { name: "SEMGREP_SEND_METRICS", value: "off" },
              { name: "SEMGREP_ENABLE_VERSION_CHECK", value: "0" },
              { name: "SEMGREP_URL", value: "file:///offline-rule-registry-disabled" },
            ],
            timeout_ms: w.request.limits.inactivity_ms,
            max_stdout_bytes: w.request.limits.max_output_bytes,
            max_stderr_bytes: w.request.limits.max_output_bytes,
            arguments: [
              "scan",
              "--metrics=off",
              "--disable-version-check",
              "--json",
              "--jobs",
              "1",
              "--test",
              "--config",
              configPath,
              "--",
              targetPath,
            ],
          };
          const observed = await runBoundedScaProcess(invocation);
          writeFileSync(
            path.join(w.root, `${name}.process.json`),
            canonicalJson({ invocation, result: observed }),
            { flag: "wx", mode: 0o600 }
          );
          expect(observed.status).toBe("nonzero_exit");
          expect(observed.exit_code).not.toBe(0);
          if (name !== "invalid_pattern") {
            const report = validateContract(
              Type.Object(
                {
                  results: Type.Record(
                    Type.String(),
                    Type.Object(
                      {
                        checks: Type.Record(
                          Type.String(),
                          Type.Object({ passed: Type.Boolean() }, { additionalProperties: true })
                        ),
                      },
                      { additionalProperties: true }
                    )
                  ),
                },
                { additionalProperties: true }
              ),
              parseScaP10NativeJson(observed.stdout),
              "Actual failed native test diagnostics"
            );
            expect(
              Object.values(report.results).some((r) =>
                Object.values(r.checks).some((c) => !c.passed)
              )
            ).toBe(true);
          }
        }
      },
      Number.POSITIVE_INFINITY
    );
  }
);
