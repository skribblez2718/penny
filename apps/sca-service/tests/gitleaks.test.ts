import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { gitleaksArguments, runScaGitleaksV1 } from "../src/adapters/gitleaks.js";

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
  const root = await mkdtemp(path.join(tmpdir(), "penny-sca-gitleaks-"));
  roots.add(root);
  const sourceRoot = path.join(root, "source;literal");
  await mkdir(sourceRoot);
  const configurationPath = path.join(root, "gitleaks.toml");
  const configuration = 'title = "fixture"\n';
  await writeFile(configurationPath, configuration, { mode: 0o600 });
  return {
    schema_id: "penny.sca-gitleaks-request.v1",
    schema_version: 1,
    source_snapshot_sha256: SNAPSHOT,
    source_root: sourceRoot,
    configuration_path: configurationPath,
    configuration_sha256: createHash("sha256").update(configuration).digest("hex"),
    runtime: {
      state: "available",
      executable: process.execPath,
      executable_sha256: nodeDigest,
      fixed_arguments: ["-e", script],
      tool_version: "gitleaks-fixture/1",
      runtime_identity: "fixture-runtime",
      runtime_sha256: RUNTIME,
    },
    timeout_ms: 2_000,
    max_output_bytes: 16_384,
  };
}

describe("S-04 required Gitleaks adapter", () => {
  it("uses a closed shell-free argv and classifies finding exit 1", async () => {
    const request = await fixture(
      "process.stdout.write(JSON.stringify([{RuleID:'generic-api-key',File:'src/app.ts',StartLine:4,EndLine:4,Fingerprint:'fixture'}]));process.exit(1)"
    );
    expect(gitleaksArguments(request)).toEqual([
      "-e",
      expect.any(String),
      "dir",
      ".",
      "--config",
      request.configuration_path,
      "--no-banner",
      "--redact",
      "--report-format",
      "json",
      "--report-path",
      "-",
      "--exit-code",
      "1",
    ]);
    const result = await runScaGitleaksV1(request);
    expect(result).toMatchObject({
      status: "findings",
      exit_code: 1,
      finding_count: 1,
      error_code: "none",
      tool_version: "gitleaks-fixture/1",
      runtime_identity: "fixture-runtime",
    });
  });

  it("distinguishes an empty scan, malformed output, and scanner failure", async () => {
    const empty = await runScaGitleaksV1(await fixture("process.stdout.write('[]')"));
    expect(empty).toMatchObject({ status: "succeeded", finding_count: 0, error_code: "none" });

    const malformed = await runScaGitleaksV1(await fixture("process.stdout.write('{}')"));
    expect(malformed).toMatchObject({ status: "failed", error_code: "invalid_output" });

    const failed = await runScaGitleaksV1(
      await fixture("process.stdout.write('[]');process.exit(2)")
    );
    expect(failed).toMatchObject({ status: "failed", error_code: "scanner_failed" });
  });

  it("returns typed unavailable without spawning and refuses configuration drift", async () => {
    const request = await fixture("throw new Error('must not run')");
    const unavailable = await runScaGitleaksV1({
      ...request,
      runtime: { state: "unavailable", reason: "missing_runtime" },
    });
    expect(unavailable).toMatchObject({
      status: "unavailable",
      error_code: "service_unavailable",
      invocation_sha256: null,
    });

    await writeFile(request.configuration_path, 'title = "drift"\n', { mode: 0o600 });
    const drift = await runScaGitleaksV1(request);
    expect(drift).toMatchObject({ status: "failed", error_code: "configuration_drift" });
  });

  it("rejects unknown fields and relative host paths", async () => {
    const request = await fixture("process.stdout.write('[]')");
    await expect(runScaGitleaksV1({ ...request, surprise: true })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(runScaGitleaksV1({ ...request, source_root: "relative" })).rejects.toMatchObject({
      code: "unsafe_path",
    });
  });
});
