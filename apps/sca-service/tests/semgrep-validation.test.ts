import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract, type ArtifactRef } from "../../orchestration/dist/contracts.js";
import {
  SCA_P10_EXPECTED_CASE_OUTCOME,
  SCA_P10_VALIDATION_CASE_CLASSES,
  validateScaP10RuleValidationResultsV1,
} from "../../orchestration/dist/sca/p10-contracts.js";
import {
  observeScaP10NativeChildV1,
  parseScaP10NativeJson,
  scaP10NativeAggregateDigests,
  type ScaP10NativeChildV1,
} from "../../orchestration/dist/sca/p10-native-tests.js";
import {
  scaP10RuleValidationArguments,
  scaP10RuleValidationRuntimeV1,
  scaP10RuleValidationBackendKeySha256,
  deriveScaP10ValidationEntry,
  buildScaP10ValidationManifest,
  validateScaP10RuleValidationAdapterResultV1,
  validateScaP10RuleValidationRequestV1,
} from "../../orchestration/dist/sca/p10-validation.js";
import { runScaRuleValidationV1 } from "../src/adapters/semgrep-validation.js";
import {
  ScaProcessRequestV1Schema,
  ScaProcessResultV1Schema,
  type ScaProcessRequestV1,
  type ScaProcessResultV1,
  type ScaProcessRunnerV1,
} from "../src/process.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const rule = "rules:\n  - id: tiny-rule\n";
const positives = new Set([
  "vulnerable",
  "generalized",
  "held_out",
  "retained_vulnerable",
  "broader_regression",
  "performance",
]);
function fixtureSource(name: string): string {
  return positives.has(name)
    ? "<?php\n// ruleid: tiny-rule\ndanger($x);\n// ok: tiny-rule\nsafe($x);\n"
    : "<?php\n// ok: tiny-rule\nsafe($x);\n";
}
function ref(content: string): ArtifactRef {
  const digest = sha256(content);
  return {
    schema_version: 2,
    artifact_id: `art_${digest}`,
    run_id: "p10-unit",
    phase: "SCA-P10",
    branch_id: null,
    kind: "fixture",
    operation_id: digest,
    version: 1,
    producer: "host:test",
    media_type: "text/plain",
    byte_length: Buffer.byteLength(content),
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}
function digestRequest(value: Record<string, unknown>) {
  const { request_sha256: _old, ...body } = value;
  return { ...body, request_sha256: sha256(canonicalJson(body)) };
}
function redigest(value: Record<string, unknown>) {
  const { result_sha256: _old, ...body } = value;
  return { ...body, result_sha256: sha256(canonicalJson(body)) };
}
function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p10-native-"));
  roots.push(root);
  const directory = path.join(root, "fixtures"),
    config = path.join(root, "rules", "candidate.yml");
  mkdirSync(directory);
  mkdirSync(path.dirname(config));
  writeFileSync(config, rule);
  for (const c of SCA_P10_VALIDATION_CASE_CLASSES)
    writeFileSync(path.join(directory, `${c}.php`), fixtureSource(c));
  const request = validateScaP10RuleValidationRequestV1(
    digestRequest({
      schema_id: "penny.sca-p10-rule-validation-request.v1",
      schema_version: 1,
      run_id: "p10-unit",
      candidate_id: `p10cand_${sha256("candidate")}`,
      rule_revision_ref: ref("revision"),
      rule_revision_sha256: ref("revision").content_digest,
      rule_id: "tiny-rule",
      rule_language: "php",
      rule_content_base64: Buffer.from(rule).toString("base64"),
      rule_sha256: sha256(rule),
      fixture_directory: "logical-fixtures",
      fixtures: SCA_P10_VALIDATION_CASE_CLASSES.map((c) => ({
        case_class: c,
        file_name: `${c}.php`,
        fixture_ref: ref(fixtureSource(c)),
        expected_outcome: SCA_P10_EXPECTED_CASE_OUTCOME[c],
      })),
      runtime: {
        state: "available",
        executable: "/fixture-only/semgrep",
        executable_sha256: sha256("fixture-only"),
        fixed_arguments: [],
        tool_version: "synthetic",
        unavailable_reason: null,
      },
      performance_bound_ms: 100,
      timeout_ms: 60000,
      max_output_bytes: 1048576,
    })
  );
  return { root, directory, config, request };
}
function processResult(
  invocation: ScaProcessRequestV1,
  stdout: string,
  overrides: Partial<ScaProcessResultV1> = {}
): ScaProcessResultV1 {
  const result = {
    schema_id: "penny.sca-process-result.v1" as const,
    schema_version: 1 as const,
    request_sha256: sha256(canonicalJson(invocation)),
    status: "succeeded" as const,
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
    failure_code: "none" as const,
    ...overrides,
  };
  return {
    ...result,
    stdout_sha256: sha256(result.stdout),
    stderr_sha256: sha256(result.stderr),
    stdout_bytes: Buffer.byteLength(result.stdout),
    stderr_bytes: Buffer.byteLength(result.stderr),
  };
}
/** Synthetic native-shaped reports, NOT captured native Semgrep output. Expected lines are
 * literal fixture annotations (self-test agreement only); reported lines model the scanner under test. Explicit empty
 * match records deliberately exercise a protocol shape not observed for real negative-only files. */
function nativeReport(
  config: string,
  file: string,
  expected: number[],
  reported = expected,
  passed = canonicalJson(expected) === canonicalJson(reported)
): Record<string, unknown> {
  return {
    config_missing_tests: [],
    config_missing_fixtests: [],
    config_with_errors: [],
    results: {
      [config]: {
        checks: {
          "tiny-rule": {
            passed,
            matches: { [file]: { expected_lines: expected, reported_lines: reported } },
            errors: [],
          },
        },
      },
    },
    fixtest_results: {},
  };
}
type Transform = (report: Record<string, unknown>, invocation: ScaProcessRequestV1) => string;
function runner(
  transform?: Transform,
  overrides: Partial<ScaProcessResultV1> = {}
): ScaProcessRunnerV1 {
  return {
    run: async (invocation) => {
      if (invocation.arguments.includes("--validate")) return processResult(invocation, "{}");
      const file = invocation.arguments.at(-1),
        config = invocation.arguments[invocation.arguments.indexOf("--config") + 1];
      if (file === undefined || config === undefined) throw new Error("missing test binding");
      const c = path.basename(file, ".php");
      const report = nativeReport(config, file, positives.has(c) ? [3] : []);
      return processResult(
        invocation,
        transform?.(report, invocation) ?? JSON.stringify(report),
        overrides
      );
    },
  };
}
async function run(w = workspace(), injected = runner()) {
  return runScaRuleValidationV1({
    request: w.request,
    ruleConfigPath: w.config,
    fixtureDirectory: w.directory,
    cwd: w.root,
    runner: injected,
  });
}
function caseResult(result: Awaited<ReturnType<typeof run>>, c: string) {
  const value = result.cases.find((v) => v.case_class === c);
  if (value === undefined) throw new Error("missing case");
  return value;
}

describe("P10 native correction regressions", () => {
  it.each([
    ["--config", "/other.yml"],
    ["--test"],
    ["--validate"],
    ["--"],
    ["other.php"],
    ["--json"],
    ["--sarif"],
    ["--metrics=on"],
    ["--output", "/tmp/output"],
    ["harmless"],
  ])("rejects every nonempty P10 fixed argument vector %j", (...fixed) => {
    const w = workspace();
    const config = {
      executable: "/fixture-only/semgrep",
      executable_sha256: sha256("fixture-only"),
      fixed_arguments: fixed,
      tool_version: "synthetic",
    };
    expect(() => scaP10RuleValidationRuntimeV1(config)).toThrow();
    expect(() => scaP10RuleValidationBackendKeySha256(config)).toThrow();
    expect(() =>
      validateScaP10RuleValidationRequestV1(
        digestRequest({ ...w.request, runtime: { ...w.request.runtime, fixed_arguments: fixed } })
      )
    ).toThrow();
    for (const kind of ["validate", "test"] as const)
      expect(() =>
        scaP10RuleValidationArguments(kind, {
          fixedArguments: fixed,
          ruleConfigPath: w.config,
          fixturePath: path.join(w.directory, "fixed.php"),
        })
      ).toThrow();
  });
  it("owns the entire argv shape and rejects path control injection", () => {
    const w = workspace(),
      file = path.join(w.directory, "--config.php");
    const common = ["--metrics=off", "--disable-version-check", "--no-git-ignore"];
    expect(
      scaP10RuleValidationArguments("test", {
        fixedArguments: [],
        ruleConfigPath: w.config,
        fixturePath: file,
      })
    ).toEqual([...common, "--test", "--json", "--config", w.config, "--", file]);
    expect(
      scaP10RuleValidationArguments("validate", { fixedArguments: [], ruleConfigPath: w.config })
    ).toEqual([...common, "--validate", "--config", w.config]);
    for (const bad of ["--config", "relative.yml", "/a/../b.yml", "/bad\0.yml"])
      expect(() =>
        scaP10RuleValidationArguments("test", {
          fixedArguments: [],
          ruleConfigPath: bad,
          fixturePath: file,
        })
      ).toThrow();
    for (const bad of ["--json", "relative.php", "/a/../b.php", "/bad\0.php"])
      expect(() =>
        scaP10RuleValidationArguments("test", {
          fixedArguments: [],
          ruleConfigPath: w.config,
          fixturePath: bad,
        })
      ).toThrow();
  });
  it.each([["--config", "/other.yml"], ["--"], ["--validate"], ["extra.php"], ["--sarif"]])(
    "rejects redigested final argv injection %j",
    async (...injected) => {
      const w = workspace(),
        result = await run(w);
      const collection = {
        ...result.test.collection,
        children: result.test.collection.children.map((c) => {
          const invocation = validateContract(
            ScaProcessRequestV1Schema,
            parseScaP10NativeJson(c.invocation_json ?? ""),
            "test invocation"
          );
          const process = validateContract(
            ScaProcessResultV1Schema,
            parseScaP10NativeJson(c.process_result_json ?? "", 8388608),
            "test process"
          );
          const invocation_json = canonicalJson({
            ...invocation,
            arguments: [...injected, ...invocation.arguments],
          });
          const invocation_sha256 = sha256(invocation_json);
          return {
            ...c,
            invocation_json,
            invocation_sha256,
            process_result_json: canonicalJson({ ...process, request_sha256: invocation_sha256 }),
          };
        }),
      };
      const forged = validateScaP10RuleValidationAdapterResultV1(
        redigest({
          ...result,
          test: { ...result.test, collection, ...scaP10NativeAggregateDigests(collection) },
        })
      );
      expect(() => deriveScaP10ValidationEntry({ request: w.request, result: forged })).toThrow(
        /invocation binding/u
      );
    }
  );
  it("retains exact config bytes and rejects internally redigested substituted config and fixture evidence", async () => {
    const w = workspace(),
      result = await run(w);
    for (const c of result.test.collection.children)
      expect(c).toMatchObject({
        config_source_base64: w.request.rule_content_base64,
        config_sha256: w.request.rule_sha256,
      });
    for (const mode of ["config", "fixture"] as const) {
      const forgedSource = Buffer.from(
        mode === "config"
          ? rule + "# substituted\n"
          : fixtureSource("vulnerable") + "// substituted\n"
      ).toString("base64");
      const collection = {
        ...result.test.collection,
        children: result.test.collection.children.map((c) =>
          mode === "config"
            ? {
                ...c,
                config_source_base64: forgedSource,
                config_sha256: sha256(Buffer.from(forgedSource, "base64")),
              }
            : {
                ...c,
                source_base64: Buffer.from(
                  fixtureSource(c.case_class) + "// substituted\n"
                ).toString("base64"),
                fixture_sha256: sha256(fixtureSource(c.case_class) + "// substituted\n"),
              }
        ),
      };
      const forged = validateScaP10RuleValidationAdapterResultV1(
        redigest({
          ...result,
          test: { ...result.test, collection, ...scaP10NativeAggregateDigests(collection) },
        })
      );
      expect(() => deriveScaP10ValidationEntry({ request: w.request, result: forged })).toThrow();
    }
    for (const patch of [
      { config_source_base64: Buffer.from(rule + "# bad digest\n").toString("base64") },
      { config_sha256: sha256("wrong config digest") },
    ]) {
      const collection = {
        ...result.test.collection,
        children: result.test.collection.children.map((c) => ({ ...c, ...patch })),
      };
      expect(() =>
        validateScaP10RuleValidationAdapterResultV1(
          redigest({
            ...result,
            test: { ...result.test, collection, ...scaP10NativeAggregateDigests(collection) },
          })
        )
      ).toThrow();
    }
    const collection = {
      ...result.test.collection,
      children: result.test.collection.children.map(
        ({ config_source_base64: _bytes, config_sha256: _sha, ...c }: Record<string, unknown>) => c
      ),
    };
    expect(() =>
      validateScaP10RuleValidationAdapterResultV1(
        redigest({ ...result, test: { ...result.test, collection } })
      )
    ).toThrow();
  });
  it.each(["validate", "test", "fixture"])(
    "rejects materialized bytes changed during %s execution",
    async (mode) => {
      const w = workspace(),
        injected = runner(),
        original = injected.run;
      injected.run = async (invocation) => {
        const result = await original(invocation);
        if (invocation.arguments.includes(mode === "validate" ? "--validate" : "--test"))
          writeFileSync(
            mode === "fixture" ? (invocation.arguments.at(-1) ?? "") : w.config,
            "substituted"
          );
        return result;
      };
      await expect(run(w, injected)).rejects.toThrow(/drift/u);
    }
  );
  it("does not admit the legacy stdout protocol", async () => {
    const result = await run(
      workspace(),
      runner(
        () =>
          "result vulnerable.php MATCH\nresult fixed.php NO_MATCH\nregression WITHIN_BOUND\nperformance WITHIN_BOUND\n"
      )
    );
    expect(result.test.status).toBe("failed");
    expect(result.cases.every((c) => c.status === "unrun")).toBe(true);
  });
  it("uses JSON and exactly eight explicit FILE invocations, with exact child evidence and no discovery", async () => {
    const w = workspace(),
      injected = runner(),
      spy = vi.spyOn(injected, "run");
    writeFileSync(path.join(w.directory, "not-requested.php"), "danger($x);");
    const result = await run(w, injected);
    expect(spy).toHaveBeenCalledTimes(9);
    expect(spy.mock.calls[0]?.[0].arguments).toContain("--validate");
    expect(spy.mock.calls.slice(1).map(([v]) => v.arguments.at(-1))).toEqual(
      w.request.fixtures.map((f) => path.join(w.directory, f.file_name))
    );
    for (const [invocation] of spy.mock.calls.slice(1)) {
      expect(invocation.arguments).toContain("--json");
      expect(invocation.timeout_ms).toBe(60000);
    }
    expect(result.test.collection.children).toHaveLength(8);
    expect(new Set(result.test.collection.children.map((c) => c.invocation_sha256)).size).toBe(8);
    expect(result.test.performance.scope).toBe("complete_test_collection");
    expect(result.cases.every((c) => c.status === "passed")).toBe(true);
    expect(
      scaP10RuleValidationArguments("test", {
        fixedArguments: [],
        ruleConfigPath: w.config,
        fixturePath: path.join(w.directory, "vulnerable.php"),
      }).at(-1)
    ).toBe(path.join(w.directory, "vulnerable.php"));
    expect(() =>
      scaP10RuleValidationArguments("test", { fixedArguments: [], ruleConfigPath: w.config })
    ).toThrow();
  });
  it.each([
    "",
    "{}",
    "not-json",
    '{"results":{},"results":{}}',
    JSON.stringify({
      config_missing_tests: [],
      config_missing_fixtests: [],
      config_with_errors: [],
      results: {},
      fixtest_results: {},
    }),
  ])("missing/invalid JSON cannot pass %s", async (stdout) => {
    const result = await run(
      workspace(),
      runner(() => stdout)
    );
    expect(result.test.status).toBe("failed");
    expect(caseResult(result, "fixed").status).toBe("unrun");
    expect(caseResult(result, "broader_regression").status).toBe("unrun");
    expect(caseResult(result, "performance").status).toBe("unrun");
  });
  it.each(["config_missing_tests", "config_missing_fixtests", "config_with_errors"])(
    "exit0 with %s cannot pass",
    async (field) => {
      const result = await run(
        workspace(),
        runner((report) => JSON.stringify({ ...report, [field]: ["native failure"] }))
      );
      expect(result.cases.every((c) => c.status === "unrun")).toBe(true);
    }
  );
  it.each([
    "empty_checks",
    "embedded_errors",
    "false_passed",
    "wrong_config",
    "basename_fixture",
    "extra_fixture",
    "other_rule",
    "duplicate_lines",
    "wrong_expected",
    "wrong_reported",
    "extra_field",
  ])("rejects native adversary %s", async (mode) => {
    const result = await run(
      workspace(),
      runner((_, invocation) => {
        const file = invocation.arguments.at(-1) ?? "missing",
          config = invocation.arguments[invocation.arguments.indexOf("--config") + 1] ?? "missing";
        const expected = positives.has(path.basename(file, ".php")) ? [3] : [];
        const check = {
          passed: true,
          errors: mode === "embedded_errors" ? ["core error"] : [],
          matches: {
            [mode === "basename_fixture" ? path.basename(file) : file]: {
              expected_lines:
                mode === "duplicate_lines" ? [3, 3] : mode === "wrong_expected" ? [2] : expected,
              reported_lines: mode === "wrong_reported" ? [4] : expected,
            },
          },
        };
        const mutated = {
          config_missing_tests: [],
          config_missing_fixtests: [],
          config_with_errors: [],
          results: {
            [mode === "wrong_config" ? path.basename(config) : config]: {
              checks:
                mode === "empty_checks"
                  ? {}
                  : {
                      [mode === "other_rule" ? "other" : "tiny-rule"]: {
                        ...check,
                        ...(mode === "false_passed" ? { passed: false } : {}),
                        matches: {
                          ...check.matches,
                          ...(mode === "extra_fixture"
                            ? { "/other/same.php": { expected_lines: [], reported_lines: [] } }
                            : {}),
                        },
                      },
                    },
            },
          },
          fixtest_results: {},
          ...(mode === "extra_field" ? { unexpected: true } : {}),
        };
        return JSON.stringify(mutated);
      })
    );
    expect(result.test.status).toBe("failed");
    expect(caseResult(result, "broader_regression").status).toBe("unrun");
  });
  it("keeps genuine native mismatches failed even if a reported match still exists", async () => {
    const w = workspace();
    const result = await run(
      w,
      runner(
        (_, invocation) =>
          JSON.stringify(
            nativeReport(
              w.config,
              invocation.arguments.at(-1) ?? "",
              positives.has(path.basename(invocation.arguments.at(-1) ?? "", ".php")) ? [3] : [],
              [4],
              false
            )
          ),
        { status: "nonzero_exit", exit_code: 1, failure_code: "nonzero_exit" }
      )
    );
    expect(caseResult(result, "vulnerable")).toMatchObject({
      observed_outcome: "match",
      status: "failed",
    });
    expect(caseResult(result, "broader_regression")).toMatchObject({
      observed_outcome: "regression",
      status: "failed",
    });
  });
  it.each(["truncated", "timed_out", "cancelled", "signalled", "spawn_failed"])(
    "incomplete child %s prevents performance PASS",
    async (mode) => {
      const overrides: Partial<ScaProcessResultV1> =
        mode === "truncated"
          ? { stdout_truncated: true }
          : mode === "signalled"
            ? { signal: "SIGTERM" }
            : mode === "timed_out"
              ? { status: "timed_out", failure_code: "timeout", exit_code: null }
              : mode === "cancelled"
                ? { status: "cancelled", failure_code: "cancelled" }
                : { status: "spawn_failed", failure_code: "spawn_failed", exit_code: null };
      const result = await run(workspace(), runner(undefined, overrides));
      expect(caseResult(result, "performance").status).toBe("unrun");
    }
  );
  it("retains full --validate timeout/refusal without bypassing metachecks", async () => {
    const injected = runner();
    const original = injected.run;
    injected.run = async (invocation) =>
      invocation.arguments.includes("--validate")
        ? processResult(invocation, "", {
            status: "timed_out",
            exit_code: null,
            signal: "SIGTERM",
            failure_code: "timeout",
          })
        : original(invocation);
    const w = workspace(),
      result = await run(w, injected);
    expect(result.validate.status).toBe("failed");
    expect(result.validate.process_result_json).toContain('"failure_code":"timeout"');
    const entry = deriveScaP10ValidationEntry({ request: w.request, result });
    expect(entry.manifest_complete).toBe(false);
  });
  it("refuses duplicate/traversing requests and materialized byte drift", async () => {
    const w = workspace();
    for (const name of ["../escape.php", "/absolute.php", "fixed.php"])
      expect(() =>
        validateScaP10RuleValidationRequestV1(
          digestRequest({
            ...w.request,
            fixtures: w.request.fixtures.map((f, i) => (i === 0 ? { ...f, file_name: name } : f)),
          })
        )
      ).toThrow();
    writeFileSync(path.join(w.directory, "vulnerable.php"), "changed");
    await expect(run(w)).rejects.toThrow(/drift/u);
  });
  it("never manufactures missing source annotations from native expected lines", async () => {
    const w = workspace();
    const source = "<?php\ndanger($x);\n";
    for (const fixture of w.request.fixtures)
      writeFileSync(path.join(w.directory, fixture.file_name), source);
    w.request = validateScaP10RuleValidationRequestV1(
      digestRequest({
        ...w.request,
        fixtures: w.request.fixtures.map((f) => ({ ...f, fixture_ref: ref(source) })),
      })
    );
    const result = await run(w);
    expect(result.cases.every((c) => c.status === "unrun")).toBe(true);
    expect(readFileSync(path.join(w.directory, "vulnerable.php"), "utf8")).toBe(source);
  });
  it("does not pass an already-cancelled or rejected collection", async () => {
    const w = workspace(),
      injected = runner(),
      spy = vi.spyOn(injected, "run");
    const result = await runScaRuleValidationV1({
      request: w.request,
      ruleConfigPath: w.config,
      fixtureDirectory: w.directory,
      cwd: w.root,
      runner: injected,
      signal: AbortSignal.abort(),
    });
    expect(spy).not.toHaveBeenCalled();
    expect(result.cases.every((c) => c.status === "unrun")).toBe(true);
    await expect(
      run(w, {
        run: async () => {
          throw new Error("process refused");
        },
      })
    ).rejects.toThrow("process refused");
  });
  it("rejects stream digest and invocation substitution from a process runner", async () => {
    const w = workspace();
    for (const patch of [{ stdout_sha256: sha256("wrong") }, { request_sha256: sha256("wrong") }])
      await expect(
        run(w, { run: async (invocation) => ({ ...processResult(invocation, "{}"), ...patch }) })
      ).rejects.toThrow(/binding/u);
  });
  it("rejects duplicate decoded JSON keys, deep nesting, oversize and escaped duplicate paths", () => {
    for (const text of [
      '{"a":1,"\\u0061":2}',
      "[".repeat(17) + "0" + "]".repeat(17),
      " ".repeat(1048577),
      '{"/a":{},"\\u002fa":{}}',
    ])
      expect(() => parseScaP10NativeJson(text)).toThrow();
  });
});

describe("P10 host timing and raw-evidence admission", () => {
  it.each([
    [99.5, "passed"],
    [100, "passed"],
    [100.5, "failed"],
  ])("aggregate measured %s excludes validate and honors E19", async (elapsed, status) => {
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(10000)
      .mockReturnValueOnce(10000 + Number(elapsed));
    const result = await run();
    expect(caseResult(result, "performance").status).toBe(status);
    expect(result.test.status).toBe("passed");
    expect(result.test.performance.elapsed_ms).toBe(elapsed);
  });
  it.each([NaN, Infinity, -1])("invalid/backward clock %s remains unrun", async (end) => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(end);
    expect(caseResult(await run(), "performance").status).toBe("unrun");
  });
  it("refuses legacy, forged case/manifest, duplicate children and changed request/run/bound", async () => {
    const w = workspace(),
      result = await run(w);
    const { collection: _collection, ...legacy } = result.test;
    expect(() =>
      validateScaP10RuleValidationAdapterResultV1(redigest({ ...result, test: legacy }))
    ).toThrow();
    expect(() =>
      validateScaP10RuleValidationAdapterResultV1(
        redigest({
          ...result,
          cases: result.cases.map((c) =>
            c.case_class === "fixed" ? { ...c, observed_outcome: "match", status: "failed" } : c
          ),
        })
      )
    ).toThrow();
    expect(() =>
      validateScaP10RuleValidationAdapterResultV1(
        redigest({
          ...result,
          test: {
            ...result.test,
            collection: {
              ...result.test.collection,
              children: result.test.collection.children.map(
                () => result.test.collection.children[0]
              ),
            },
          },
        })
      )
    ).toThrow();
    for (const update of [{ run_id: "other" }, { performance_bound_ms: 101 }]) {
      const changed = validateScaP10RuleValidationRequestV1(
        digestRequest({ ...w.request, ...update })
      );
      const rebound = validateScaP10RuleValidationAdapterResultV1(
        redigest({ ...result, request_sha256: changed.request_sha256 })
      );
      expect(() => deriveScaP10ValidationEntry({ request: changed, result: rebound })).toThrow();
    }
    const entry = deriveScaP10ValidationEntry({ request: w.request, result });
    const manifest = buildScaP10ValidationManifest({ run_id: w.request.run_id, entries: [entry] });
    const { validation_sha256: _digest, ...body } = manifest;
    const forged = {
      ...body,
      candidates: [{ ...entry, test: { ...entry.test, collection: null } }],
    };
    expect(() =>
      validateScaP10RuleValidationResultsV1({
        ...forged,
        validation_sha256: sha256(canonicalJson(forged)),
      })
    ).toThrow();
  });
  it("unavailable runtime does not invoke or fabricate coverage", async () => {
    const w = workspace(),
      injected = runner(),
      spy = vi.spyOn(injected, "run");
    w.request = validateScaP10RuleValidationRequestV1(
      digestRequest({
        ...w.request,
        runtime: {
          state: "unavailable",
          executable: null,
          executable_sha256: null,
          fixed_arguments: [],
          tool_version: null,
          unavailable_reason: "missing_runtime",
        },
      })
    );
    const result = await run(w, injected);
    expect(spy).not.toHaveBeenCalled();
    expect(result.cases.every((c) => c.status === "unrun")).toBe(true);
  });
});

// Optional DATA replay only; never executes Semgrep. Caller supplies the original observation root.
describe.skipIf(process.env.PENNY_P10_NATIVE_OBSERVATIONS === undefined)(
  "original native observation discrimination",
  () => {
    it("accepts observed positive lines; rejects empty negative checks and exit0 internal failure", () => {
      const root = process.env.PENNY_P10_NATIVE_OBSERVATIONS;
      if (root === undefined) throw new Error("observation root absent");
      const source =
        "// ruleid: p10-native-needle\ndangerous(input);\n// ok: p10-native-needle\nsafe(input);\n";
      const base: ScaP10NativeChildV1 = {
        case_class: "vulnerable",
        file_name: "candidate.js",
        rule_id: "p10-native-needle",
        config_path: "/work/rules/candidate.yml",
        config_source_base64: Buffer.from(rule).toString("base64"),
        config_sha256: sha256(rule),
        fixture_path: "/work/fixtures/candidate.js",
        fixture_sha256: sha256(source),
        source_base64: Buffer.from(source).toString("base64"),
        invocation_json: "{}",
        invocation_sha256: sha256("{}"),
        process_result_json: null,
        completed: true,
        exit_status: 0,
        stdout: "",
        stderr: "",
        stdout_sha256: sha256(""),
        stderr_sha256: sha256(""),
      };
      for (const name of [
        "r3-positive-file",
        "r3-negative-file",
        "r4-native-negative",
        "r2-positive-file",
      ]) {
        const stdout = readFileSync(path.join(root, `${name}.stdout`), "utf8");
        const observation = observeScaP10NativeChildV1({
          ...base,
          stdout,
          stdout_sha256: sha256(stdout),
        });
        expect(observation.observed).toBe(name === "r3-positive-file" ? "match" : null);
        expect(observation.passed).toBe(name === "r3-positive-file");
      }
    });
  }
);
