import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { canonicalJson, sha256 } from "../../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../../orchestration/dist/contracts.js";
import {
  SCA_P10_EXPECTED_CASE_OUTCOME,
  deriveScaP10PerformanceCaseV1,
} from "../../../orchestration/dist/sca/p10-contracts.js";
import {
  P10_NATIVE_STREAM_BYTES,
  scaP10NativeAggregateDigests,
  scaP10NativeCaseV1,
  scaP10NativeCollectionComplete,
  scaP10NativeCollectionExit,
  type ScaP10NativeChildV1,
  type ScaP10NativeCollectionV1,
} from "../../../orchestration/dist/sca/p10-native-tests.js";
import {
  scaP10RuleValidationArguments,
  validateScaP10RuleValidationAdapterResultV1,
  validateScaP10RuleValidationRequestV1,
  type ScaP10RuleValidationAdapterResultV1,
  type ScaP10RuleValidationRequestV1,
} from "../../../orchestration/dist/sca/p10-validation.js";
import {
  type ScaP10RuleValidationInvocationV1,
  type ScaP10RuleValidationRunnerV1,
} from "../../../orchestration/dist/sca/p10-production-host.js";
import {
  directScaProcessRunnerV1,
  ScaProcessResultV1Schema,
  type ScaProcessRequestV1,
  type ScaProcessResultV1,
  type ScaProcessRunnerV1,
} from "../process.js";

/** No supplied clock seam. This measures the entire eight-child serial collection, not eight
 * invocations mislabeled as one process. Includes verification/intake; excludes materialization
 * and full --validate. Acceptance bounds never terminate productive execution. */
function now(): number | null {
  try {
    const n = performance.now();
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}
function exactFile(file: string, expectedSha: string): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > P10_NATIVE_STREAM_BYTES)
      throw new Error("P10 materialized file size/custody");
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    const bytes = buffer.subarray(0, length);
    const after = fstatSync(fd);
    if (
      bytes.length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      sha256(bytes) !== expectedSha
    )
      throw new Error("P10 materialized bytes drifted");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function completed(result: ScaProcessResultV1, signal?: AbortSignal): boolean {
  return (
    signal?.aborted !== true &&
    result.signal === null &&
    !result.stdout_truncated &&
    !result.stderr_truncated &&
    ((result.status === "succeeded" && result.exit_code === 0 && result.failure_code === "none") ||
      (result.status === "nonzero_exit" &&
        result.exit_code === 1 &&
        result.failure_code === "nonzero_exit"))
  );
}
async function invoke(
  kind: "validate" | "test",
  input: {
    readonly request: ScaP10RuleValidationRequestV1;
    readonly ruleConfigPath: string;
    readonly fixturePath?: string;
    readonly cwd: string;
    readonly runner: ScaProcessRunnerV1;
    readonly signal?: AbortSignal;
  }
): Promise<{ invocation: ScaProcessRequestV1; result: ScaProcessResultV1 } | null> {
  const runtime = input.request.runtime;
  if (
    runtime.state !== "available" ||
    runtime.executable === null ||
    runtime.executable_sha256 === null ||
    input.signal?.aborted === true
  )
    return null;
  const invocation: ScaProcessRequestV1 = {
    schema_id: "penny.sca-process-request.v1",
    schema_version: 1,
    executable: runtime.executable,
    executable_sha256: runtime.executable_sha256,
    arguments: [
      ...scaP10RuleValidationArguments(kind, {
        fixedArguments: runtime.fixed_arguments,
        ruleConfigPath: input.ruleConfigPath,
        ...(input.fixturePath === undefined ? {} : { fixturePath: input.fixturePath }),
      }),
    ],
    cwd: input.cwd,
    environment: [
      { name: "HOME", value: input.cwd },
      { name: "PATH", value: "/usr/bin:/bin" },
      { name: "SEMGREP_ENABLE_VERSION_CHECK", value: "0" },
      { name: "SEMGREP_SEND_METRICS", value: "off" },
    ],
    timeout_ms: input.request.timeout_ms,
    max_stdout_bytes: input.request.max_output_bytes,
    max_stderr_bytes: input.request.max_output_bytes,
  };
  const result = validateContract(
    ScaProcessResultV1Schema,
    await input.runner.run(invocation, input.signal),
    "P10 process result"
  );
  if (
    result.request_sha256 !== sha256(canonicalJson(invocation)) ||
    result.stdout_bytes !== Buffer.byteLength(result.stdout) ||
    result.stderr_bytes !== Buffer.byteLength(result.stderr) ||
    result.stdout_bytes > input.request.max_output_bytes ||
    result.stderr_bytes > input.request.max_output_bytes ||
    result.stdout_sha256 !== sha256(result.stdout) ||
    result.stderr_sha256 !== sha256(result.stderr)
  )
    throw new Error("P10 process result binding/streams drifted");
  return { invocation, result };
}

/** P10-only collection: full --validate is preserved, followed by exactly the eight requested
 * FILE targets. No scan, annotations, registry fetch, custom stdout fallback, or discovery. */
export async function runScaRuleValidationV1(input: {
  readonly request: unknown;
  readonly ruleConfigPath: string;
  readonly fixtureDirectory: string;
  readonly cwd: string;
  readonly runner?: ScaProcessRunnerV1;
  readonly signal?: AbortSignal;
}): Promise<ScaP10RuleValidationAdapterResultV1> {
  const request = validateScaP10RuleValidationRequestV1(input.request);
  for (const target of [input.cwd, input.ruleConfigPath, input.fixtureDirectory]) {
    if (!path.isAbsolute(target) || path.normalize(target) !== target || target.includes("\0"))
      throw new Error("P10 materialized path not absolute/canonical");
  }
  if (
    path.dirname(input.fixtureDirectory) !== input.cwd ||
    path.basename(input.fixtureDirectory) !== "fixtures" ||
    path.dirname(input.ruleConfigPath) !== path.join(input.cwd, "rules")
  )
    throw new Error("P10 materialized layout drift");
  const configBytes = exactFile(input.ruleConfigPath, request.rule_sha256);
  if (configBytes.toString("base64") !== request.rule_content_base64)
    throw new Error("P10 materialized config bytes drifted from request");
  const runner = input.runner ?? directScaProcessRunnerV1;
  const common = {
    request,
    ruleConfigPath: input.ruleConfigPath,
    cwd: input.cwd,
    runner,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  const validation = await invoke("validate", common);
  exactFile(input.ruleConfigPath, request.rule_sha256);
  const started = now();
  const children: ScaP10NativeChildV1[] = [];
  for (const fixture of request.fixtures) {
    const fixturePath = path.join(input.fixtureDirectory, fixture.file_name);
    const bytes = exactFile(fixturePath, fixture.fixture_ref.content_digest);
    exactFile(input.ruleConfigPath, request.rule_sha256);
    const child = await invoke("test", { ...common, fixturePath });
    exactFile(fixturePath, fixture.fixture_ref.content_digest);
    exactFile(input.ruleConfigPath, request.rule_sha256);
    children.push({
      case_class: fixture.case_class,
      file_name: fixture.file_name,
      fixture_sha256: fixture.fixture_ref.content_digest,
      source_base64: bytes.toString("base64"),
      rule_id: request.rule_id,
      config_path: input.ruleConfigPath,
      config_source_base64: configBytes.toString("base64"),
      config_sha256: sha256(configBytes),
      fixture_path: fixturePath,
      invocation_json: child === null ? null : canonicalJson(child.invocation),
      invocation_sha256: child?.result.request_sha256 ?? null,
      process_result_json: child === null ? null : canonicalJson(child.result),
      exit_status: child?.result.exit_code ?? null,
      completed: child !== null && completed(child.result, input.signal),
      stdout: child?.result.stdout ?? "",
      stderr: child?.result.stderr ?? "",
      stdout_sha256: sha256(child?.result.stdout ?? ""),
      stderr_sha256: sha256(child?.result.stderr ?? ""),
    });
  }
  const collection: ScaP10NativeCollectionV1 = { protocol: "semgrep_test_json_file_v1", children };
  const finished = now();
  const elapsed = started === null || finished === null ? null : finished - started;
  const test = {
    collection,
    ...scaP10NativeAggregateDigests(collection),
    exit_status: scaP10NativeCollectionExit(collection),
    status: scaP10NativeCollectionComplete(collection) ? ("passed" as const) : ("failed" as const),
    performance: {
      clock: "host_monotonic" as const,
      scope: "complete_test_collection" as const,
      elapsed_ms:
        elapsed !== null &&
        Number.isFinite(elapsed) &&
        elapsed >= 0 &&
        elapsed <= Number.MAX_SAFE_INTEGER
          ? elapsed
          : null,
      bound_ms: request.performance_bound_ms,
    },
  };
  const performanceCase = deriveScaP10PerformanceCaseV1(test);
  const cases = request.fixtures.map((fixture, index) => {
    const child = children[index];
    if (child === undefined) throw new Error("P10 missing native child");
    return {
      case_class: fixture.case_class,
      ...(fixture.case_class === "performance"
        ? performanceCase
        : scaP10NativeCaseV1(child, SCA_P10_EXPECTED_CASE_OUTCOME[fixture.case_class])),
    };
  });
  const body = {
    schema_id: "penny.sca-p10-rule-validation-result.v1",
    schema_version: 1 as const,
    run_id: request.run_id,
    candidate_id: request.candidate_id,
    rule_revision_ref: request.rule_revision_ref,
    rule_revision_sha256: request.rule_revision_sha256,
    request_sha256: request.request_sha256,
    validate: {
      invocation_sha256: validation?.result.request_sha256 ?? null,
      invocation_json: validation === null ? null : canonicalJson(validation.invocation),
      process_result_json: validation === null ? null : canonicalJson(validation.result),
      executable_sha256: request.runtime.executable_sha256,
      exit_status: validation?.result.exit_code ?? null,
      raw_result_sha256: validation?.result.stdout_sha256 ?? null,
      status:
        validation !== null &&
        completed(validation.result, input.signal) &&
        validation.result.exit_code === 0
          ? ("passed" as const)
          : ("failed" as const),
    },
    test,
    cases,
  };
  return validateScaP10RuleValidationAdapterResultV1({
    ...body,
    result_sha256: sha256(canonicalJson(body)),
  });
}
export function createScaP10RuleValidationRunnerV1(
  input: { readonly runner?: ScaProcessRunnerV1 } = {}
): ScaP10RuleValidationRunnerV1 {
  return (invocation: ScaP10RuleValidationInvocationV1) =>
    runScaRuleValidationV1({
      request: invocation.request,
      ruleConfigPath: invocation.rule_config_path,
      fixtureDirectory: invocation.fixture_directory,
      cwd: invocation.cwd,
      runner: input.runner ?? directScaProcessRunnerV1,
      ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
    });
}
