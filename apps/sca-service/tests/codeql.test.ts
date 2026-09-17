import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { codeqlArguments, runScaCodeqlV1 } from "../src/adapters/codeql.js";

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
  const root = await mkdtemp(path.join(tmpdir(), "penny-sca-codeql-"));
  roots.add(root);
  const databaseRoot = path.join(root, "database;literal");
  await mkdir(databaseRoot);
  const querySuite = path.join(root, "queries.qls");
  const queries = "- description: fixture\n";
  await writeFile(querySuite, queries, { mode: 0o600 });
  return {
    schema_id: "penny.sca-codeql-request.v1",
    schema_version: 1,
    source_snapshot_sha256: SNAPSHOT,
    database_root: databaseRoot,
    query_suite: querySuite,
    query_suite_sha256: createHash("sha256").update(queries).digest("hex"),
    runtime: {
      state: "available",
      executable: process.execPath,
      executable_sha256: nodeDigest,
      fixed_arguments: ["-e", script],
      tool_version: "codeql-fixture/1",
      runtime_identity: "fixture-runtime",
      runtime_sha256: RUNTIME,
    },
    timeout_ms: 2_000,
    max_output_bytes: 16_384,
  };
}

describe("S-04-T2 CodeQL adapter", () => {
  it("uses a closed database-analyze argv and counts SARIF findings", async () => {
    const request = await fixture(
      "process.stdout.write(JSON.stringify({version:'2.1.0',runs:[{results:[{ruleId:'fixture'}]}]}))"
    );
    expect(codeqlArguments(request)).toEqual([
      "-e",
      expect.any(String),
      "database",
      "analyze",
      request.database_root,
      request.query_suite,
      "--format=sarif-latest",
      "--output=/dev/stdout",
      "--no-print-diagnostics-summary",
      "--threads=1",
    ]);
    const result = await runScaCodeqlV1(request);
    expect(result).toMatchObject({
      status: "findings",
      finding_count: 1,
      error_code: "none",
      source_snapshot_sha256: SNAPSHOT,
      query_suite_sha256: request.query_suite_sha256,
      tool_version: "codeql-fixture/1",
    });
  });

  it("distinguishes successful empty SARIF, malformed output, and process failure", async () => {
    const empty = await runScaCodeqlV1(
      await fixture("process.stdout.write(JSON.stringify({version:'2.1.0',runs:[{results:[]}]}))")
    );
    expect(empty).toMatchObject({ status: "succeeded", finding_count: 0, error_code: "none" });

    const malformed = await runScaCodeqlV1(await fixture("process.stdout.write('{}')"));
    expect(malformed).toMatchObject({ status: "failed", error_code: "invalid_output" });

    const failed = await runScaCodeqlV1(
      await fixture("process.stderr.write('engine failed');process.exit(2)")
    );
    expect(failed).toMatchObject({ status: "failed", error_code: "scanner_failed", exit_code: 2 });
    expect(failed.raw_stderr).toBe("engine failed");
  });

  it("returns typed unavailable and detects query-suite drift", async () => {
    const request = await fixture("throw new Error('must not run')");
    const unavailable = await runScaCodeqlV1({
      ...request,
      runtime: { state: "unavailable", reason: "missing_runtime" },
    });
    expect(unavailable).toMatchObject({
      status: "unavailable",
      error_code: "service_unavailable",
      invocation_sha256: null,
    });

    await writeFile(request.query_suite, "- description: drift\n", { mode: 0o600 });
    expect(await runScaCodeqlV1(request)).toMatchObject({
      status: "failed",
      error_code: "query_suite_drift",
    });
  });

  it("rejects unknown fields and relative database paths", async () => {
    const request = await fixture("process.stdout.write('{}')");
    await expect(runScaCodeqlV1({ ...request, unexpected: true })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(runScaCodeqlV1({ ...request, database_root: "relative" })).rejects.toMatchObject({
      code: "unsafe_path",
    });
  });
});
