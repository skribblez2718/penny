import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { runScaSemgrepV1, semgrepArguments } from "../src/adapters/semgrep.js";

const SNAPSHOT = "a".repeat(64);
const RUNTIME = "b".repeat(64);
const roots = new Set<string>();
let nodeDigest = "";

beforeAll(async () => {
  nodeDigest = createHash("sha256")
    .update(await readFile(process.execPath))
    .digest("hex");
});

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

async function fixture(script: string) {
  const root = await mkdtemp(path.join(tmpdir(), "penny-sca-semgrep-"));
  roots.add(root);
  const sourceRoot = path.join(root, "source;literal");
  const scratchRoot = path.join(root, "scratch");
  await mkdir(sourceRoot);
  await mkdir(scratchRoot);
  const ruleConfig = path.join(root, "rules.yml");
  const rules = "rules: []\n";
  await writeFile(ruleConfig, rules, { mode: 0o600 });
  return {
    schema_id: "penny.sca-semgrep-request.v1",
    schema_version: 1,
    source_snapshot_sha256: SNAPSHOT,
    source_root: sourceRoot,
    scratch_root: scratchRoot,
    rule_config: ruleConfig,
    rule_config_sha256: createHash("sha256").update(rules).digest("hex"),
    runtime: {
      state: "available",
      executable: process.execPath,
      executable_sha256: nodeDigest,
      fixed_arguments: ["-e", script],
      tool_version: "semgrep-fixture/1",
      runtime_identity: "fixture-runtime",
      runtime_sha256: RUNTIME,
    },
    timeout_ms: 2_000,
    max_output_bytes: 16_384,
  };
}

describe("S-04-T2 Semgrep adapter", () => {
  it("uses one closed shell-free argv and classifies finding exit 1", async () => {
    const request = await fixture(
      "process.stdout.write(JSON.stringify({results:[{check_id:'fixture.rule'}],errors:[]}));process.exit(1)"
    );
    expect(semgrepArguments(request)).toEqual([
      "-e",
      expect.any(String),
      "scan",
      "--json",
      "--error",
      "--metrics=off",
      "--disable-version-check",
      "--no-git-ignore",
      "--x-ignore-semgrepignore-files",
      "--no-rewrite-rule-ids",
      "--config",
      request.rule_config,
      "--",
      ".",
    ]);
    const result = await runScaSemgrepV1(request);
    expect(result).toMatchObject({
      status: "findings",
      exit_code: 1,
      finding_count: 1,
      engine_error_count: 0,
      error_code: "none",
      source_snapshot_sha256: SNAPSHOT,
      rule_config_sha256: request.rule_config_sha256,
      tool_version: "semgrep-fixture/1",
      runtime_identity: "fixture-runtime",
    });
    expect(result.raw_stdout).toContain("fixture.rule");
  });

  it("distinguishes a successful empty scan from engine errors and malformed output", async () => {
    const empty = await runScaSemgrepV1(
      await fixture("process.stdout.write(JSON.stringify({results:[],errors:[]}))")
    );
    expect(empty).toMatchObject({ status: "succeeded", finding_count: 0, error_code: "none" });

    const engineError = await runScaSemgrepV1(
      await fixture("process.stdout.write(JSON.stringify({results:[],errors:[{type:'parse'}]}))")
    );
    expect(engineError).toMatchObject({
      status: "failed",
      engine_error_count: 1,
      error_code: "scanner_failed",
    });

    const malformed = await runScaSemgrepV1(await fixture("process.stdout.write('not-json')"));
    expect(malformed).toMatchObject({ status: "failed", error_code: "invalid_output" });
  });

  it("returns typed unavailable without spawning and refuses rule drift", async () => {
    const request = await fixture("throw new Error('must not run')");
    const unavailable = await runScaSemgrepV1({
      ...request,
      runtime: { state: "unavailable", reason: "unqualified_runtime" },
    });
    expect(unavailable).toMatchObject({
      status: "unavailable",
      error_code: "service_unavailable",
      invocation_sha256: null,
    });

    await writeFile(request.rule_config, "rules:\n  - drift\n", { mode: 0o600 });
    const drift = await runScaSemgrepV1(request);
    expect(drift).toMatchObject({ status: "failed", error_code: "rule_config_drift" });
  });

  it("rejects unknown fields and relative host paths before execution", async () => {
    const request = await fixture("process.stdout.write('{}')");
    await expect(runScaSemgrepV1({ ...request, unexpected: true })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(runScaSemgrepV1({ ...request, source_root: "relative" })).rejects.toMatchObject({
      code: "unsafe_path",
    });
    await expect(
      runScaSemgrepV1({ ...request, scratch_root: request.source_root })
    ).rejects.toMatchObject({ code: "unsafe_path" });
  });
});
