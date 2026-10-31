import path from "node:path";
import { TextDecoder } from "node:util";
import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract } from "../contracts.js";
import { Sha256Schema } from "../skill-contracts/common.js";

/** P10-only intake ceilings; eight serial FILE calls, never discovery. */
export const P10_NATIVE_STREAM_BYTES = 1_048_576;
const closed = { additionalProperties: false } as const;
const text = Type.String({ maxLength: P10_NATIVE_STREAM_BYTES });
const absolute = Type.String({ minLength: 1, maxLength: 4096 });
const exit = Type.Union([Type.Integer({ minimum: 0, maximum: 255 }), Type.Null()]);
export const ScaP10NativeChildV1Schema = Type.Object(
  {
    case_class: Type.String({ minLength: 1, maxLength: 64 }),
    file_name: Type.String({ minLength: 1, maxLength: 1024 }),
    fixture_sha256: Sha256Schema,
    source_base64: Type.String({ maxLength: 1_398_104 }),
    rule_id: Type.String({ minLength: 1, maxLength: 256 }),
    // Paths locate historical invocations; only retained exact bytes bind historical inputs.
    config_path: absolute,
    config_source_base64: Type.String({ maxLength: 1_398_104 }),
    config_sha256: Sha256Schema,
    fixture_path: absolute,
    invocation_json: Type.Union([text, Type.Null()]),
    process_result_json: Type.Union([Type.String({ maxLength: 8_388_608 }), Type.Null()]),
    invocation_sha256: Type.Union([Sha256Schema, Type.Null()]),
    exit_status: exit,
    completed: Type.Boolean(),
    stdout: text,
    stderr: text,
    stdout_sha256: Sha256Schema,
    stderr_sha256: Sha256Schema,
  },
  closed
);
export const ScaP10NativeCollectionV1Schema = Type.Object(
  {
    protocol: Type.Literal("semgrep_test_json_file_v1"),
    children: Type.Array(ScaP10NativeChildV1Schema, { minItems: 8, maxItems: 8 }),
  },
  closed
);
export type ScaP10NativeChildV1 = Static<typeof ScaP10NativeChildV1Schema>;
export type ScaP10NativeCollectionV1 = Static<typeof ScaP10NativeCollectionV1Schema>;

function refuse(): never {
  throw new Error("SCA P10 invalid or ambiguous native JSON evidence");
}

/** Reject duplicate decoded keys and excessive depth/work BEFORE JSON.parse/schema traversal.
 * JSON syntax is still checked by JSON.parse; this is a bounded lexical ambiguity guard. */
export function parseScaP10NativeJson(
  textValue: string,
  maxBytes = P10_NATIVE_STREAM_BYTES
): unknown {
  if (!textValue.length || Buffer.byteLength(textValue) > maxBytes) refuse();
  const stack: (Set<string> | null)[] = [];
  let nodes = 0;
  for (let at = 0; at < textValue.length; at++) {
    const c = textValue[at];
    if (c === '"') {
      const start = at++;
      for (; at < textValue.length; at++) {
        if (textValue[at] === "\\") {
          at++;
          continue;
        }
        if (textValue[at] === '"') break;
      }
      const token: unknown = JSON.parse(textValue.slice(start, at + 1));
      if (typeof token !== "string") refuse();
      let next = at + 1;
      while (/\s/u.test(textValue[next] ?? "!")) next++;
      if (textValue[next] === ":") {
        const keys = stack.at(-1);
        if (keys === null || keys === undefined || keys.has(token)) refuse();
        keys.add(token);
      }
      if (++nodes > 32768) refuse();
    } else if (c === "{" || c === "[") {
      stack.push(c === "{" ? new Set() : null);
      if (stack.length > 16 || ++nodes > 32768) refuse();
    } else if (c === "}" || c === "]") {
      if (stack.length === 0) refuse();
      stack.pop();
    } else if (c === "," && ++nodes > 32768) refuse();
  }
  if (stack.length !== 0) refuse();
  const parsed: unknown = JSON.parse(textValue);
  return parsed;
}
const lines = Type.Array(Type.Integer({ minimum: 1, maximum: P10_NATIVE_STREAM_BYTES }), {
  maxItems: 32768,
});
const Match = Type.Object({ expected_lines: lines, reported_lines: lines }, closed);
const Check = Type.Object(
  {
    passed: Type.Boolean(),
    matches: Type.Record(absolute, Match),
    errors: Type.Array(Type.Unknown(), { maxItems: 128 }),
  },
  closed
);
const Report = Type.Object(
  {
    config_missing_tests: Type.Array(absolute, { maxItems: 8 }),
    config_missing_fixtests: Type.Array(absolute, { maxItems: 8 }),
    config_with_errors: Type.Array(Type.Unknown(), { maxItems: 128 }),
    results: Type.Record(
      absolute,
      Type.Object(
        { checks: Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Check) },
        closed
      )
    ),
    fixtest_results: Type.Record(absolute, Type.Object({ passed: Type.Boolean() }, closed)),
  },
  closed
);
const ProcessResult = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-process-result.v1"),
    schema_version: Type.Literal(1),
    request_sha256: Sha256Schema,
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("nonzero_exit"),
      Type.Literal("timed_out"),
      Type.Literal("cancelled"),
      Type.Literal("output_limit"),
      Type.Literal("spawn_failed"),
    ]),
    exit_code: exit,
    signal: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
    stdout: text,
    stderr: text,
    stdout_sha256: Sha256Schema,
    stderr_sha256: Sha256Schema,
    stdout_bytes: Type.Integer({ minimum: 0, maximum: P10_NATIVE_STREAM_BYTES }),
    stderr_bytes: Type.Integer({ minimum: 0, maximum: P10_NATIVE_STREAM_BYTES }),
    stdout_truncated: Type.Boolean(),
    stderr_truncated: Type.Boolean(),
    failure_code: Type.Union([
      Type.Literal("none"),
      Type.Literal("nonzero_exit"),
      Type.Literal("timeout"),
      Type.Literal("cancelled"),
      Type.Literal("output_limit"),
      Type.Literal("spawn_failed"),
    ]),
  },
  closed
);
export function readScaP10ProcessEvidenceV1(raw: string) {
  const result = validateContract(
    ProcessResult,
    parseScaP10NativeJson(raw, 8_388_608),
    "P10 process evidence"
  );
  if (
    result.stdout_bytes !== Buffer.byteLength(result.stdout) ||
    result.stderr_bytes !== Buffer.byteLength(result.stderr) ||
    result.stdout_sha256 !== sha256(result.stdout) ||
    result.stderr_sha256 !== sha256(result.stderr)
  )
    refuse();
  const completed =
    result.signal === null &&
    !result.stdout_truncated &&
    !result.stderr_truncated &&
    ((result.status === "succeeded" && result.exit_code === 0 && result.failure_code === "none") ||
      (result.status === "nonzero_exit" &&
        result.exit_code === 1 &&
        result.failure_code === "nonzero_exit"));
  return { result, completed };
}
export function validateScaP10ValidateEvidenceV1(evidence: {
  readonly status: string;
  readonly invocation_sha256: string | null;
  readonly exit_status: number | null;
  readonly raw_result_sha256: string | null;
  readonly process_result_json: string | null;
  readonly invocation_json: string | null;
}): void {
  if (evidence.process_result_json === null) {
    if (
      evidence.status !== "failed" ||
      evidence.invocation_json !== null ||
      evidence.invocation_sha256 !== null ||
      evidence.exit_status !== null ||
      evidence.raw_result_sha256 !== null
    )
      refuse();
    return;
  }
  const { result, completed } = readScaP10ProcessEvidenceV1(evidence.process_result_json);
  if (
    evidence.invocation_json === null ||
    sha256(evidence.invocation_json) !== evidence.invocation_sha256 ||
    result.request_sha256 !== evidence.invocation_sha256 ||
    result.exit_code !== evidence.exit_status ||
    result.stdout_sha256 !== evidence.raw_result_sha256 ||
    (evidence.status === "passed" && (!completed || result.exit_code !== 0))
  )
    refuse();
}
export interface ScaP10NativeObservationV1 {
  readonly observed: "match" | "no_match" | null;
  readonly passed: boolean;
  readonly expected_lines: readonly number[];
  readonly reported_lines: readonly number[];
}
const absent: ScaP10NativeObservationV1 = {
  observed: null,
  passed: false,
  expected_lines: [],
  reported_lines: [],
};
function normalizedAbsolute(value: string): boolean {
  return path.isAbsolute(value) && path.normalize(value) === value && !value.includes("\0");
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Compares native lines with retained fixture annotations, NOT independent correctness or held-out
 * truth. Production proposals currently author these fixtures themselves; production qualification
 * must refuse absent independently approved truth. Never infer annotations from scanner findings.
 * This bounded slice supports full-line // ruleid: / // ok: annotations for PHP/JS/TS only. */
export function observeScaP10NativeChildV1(child: ScaP10NativeChildV1): ScaP10NativeObservationV1 {
  try {
    if (
      !child.completed ||
      child.invocation_sha256 === null ||
      child.invocation_json === null ||
      !normalizedAbsolute(child.config_path) ||
      !normalizedAbsolute(child.fixture_path) ||
      child.stdout_sha256 !== sha256(child.stdout) ||
      child.stderr_sha256 !== sha256(child.stderr) ||
      Buffer.byteLength(child.stderr) > P10_NATIVE_STREAM_BYTES ||
      sha256(child.invocation_json) !== child.invocation_sha256
    )
      return absent;
    const source = Buffer.from(child.source_base64, "base64");
    if (
      source.length > P10_NATIVE_STREAM_BYTES ||
      source.toString("base64") !== child.source_base64 ||
      sha256(source) !== child.fixture_sha256
    )
      return absent;
    const sourceLines = new TextDecoder("utf-8", { fatal: true }).decode(source).split("\n");
    const expected: number[] = [],
      negatives: number[] = [];
    for (let i = 0; i < sourceLines.length; i++) {
      const annotation = /^\s*\/\/\s*(ruleid|ok):\s*([^\r\n]+?)\s*$/u.exec(sourceLines[i] ?? "");
      if (annotation === null) continue;
      const ids = (annotation[2] ?? "").split(",").map((id) => id.trim());
      if (
        new Set(ids).size !== ids.length ||
        ids.some((id) => id !== child.rule_id) ||
        i + 1 >= sourceLines.length
      )
        return absent;
      (annotation[1] === "ruleid" ? expected : negatives).push(i + 2);
    }
    if (expected.length + negatives.length === 0) return absent;
    const report = validateContract(
      Report,
      parseScaP10NativeJson(child.stdout),
      "P10 native test report"
    );
    if (
      report.config_missing_tests.length ||
      report.config_missing_fixtests.length ||
      report.config_with_errors.length ||
      Object.keys(report.fixtest_results).length ||
      !same(Object.keys(report.results), [child.config_path])
    )
      return absent;
    const checks = report.results[child.config_path]?.checks;
    if (checks === undefined || !same(Object.keys(checks), [child.rule_id])) return absent;
    const check = checks[child.rule_id];
    if (
      check === undefined ||
      check.errors.length ||
      !same(Object.keys(check.matches), [child.fixture_path])
    )
      return absent;
    const match = check.matches[child.fixture_path];
    if (match === undefined) return absent;
    for (const values of [match.expected_lines, match.reported_lines]) {
      if (
        !same(
          values,
          [...new Set(values)].sort((a, b) => a - b)
        ) ||
        values.some((n) => n > sourceLines.length)
      )
        return absent;
    }
    if (!same(match.expected_lines, expected)) return absent;
    const equal = same(expected, match.reported_lines);
    if (
      check.passed !== equal ||
      (equal && child.exit_status !== 0) ||
      (!equal && child.exit_status !== 1)
    )
      return absent;
    return {
      observed: match.reported_lines.length ? "match" : "no_match",
      passed: equal,
      expected_lines: expected,
      reported_lines: match.reported_lines,
    };
  } catch {
    return absent;
  }
}

function exactSource(base64: string, digest: string): void {
  const bytes = Buffer.from(base64, "base64");
  if (
    bytes.length > P10_NATIVE_STREAM_BYTES ||
    bytes.toString("base64") !== base64 ||
    sha256(bytes) !== digest
  )
    refuse();
}

/** Admission replays raw native JSON, annotation agreement, child binding and aggregate digests. */
export function validateScaP10NativeCollectionV1(value: unknown): ScaP10NativeCollectionV1 {
  const collection = validateContract(
    ScaP10NativeCollectionV1Schema,
    value,
    "P10 native collection"
  );
  const classes = collection.children.map((child) => child.case_class);
  if (
    new Set(classes).size !== 8 ||
    !same(classes, [...classes].sort()) ||
    new Set(collection.children.map((child) => child.fixture_path)).size !== 8 ||
    new Set(collection.children.map((child) => child.file_name)).size !== 8 ||
    new Set(collection.children.map((child) => child.config_path)).size !== 1 ||
    new Set(collection.children.map((child) => child.config_sha256)).size !== 1 ||
    new Set(collection.children.map((child) => child.config_source_base64)).size !== 1 ||
    new Set(collection.children.map((child) => child.rule_id)).size !== 1
  )
    refuse();
  for (const child of collection.children) {
    exactSource(child.config_source_base64, child.config_sha256);
    exactSource(child.source_base64, child.fixture_sha256);
    if (child.process_result_json === null) {
      if (
        child.completed ||
        child.invocation_json !== null ||
        child.exit_status !== null ||
        child.stdout !== "" ||
        child.stderr !== ""
      )
        refuse();
    } else {
      const { result, completed } = readScaP10ProcessEvidenceV1(child.process_result_json);
      if (
        (child.completed && !completed) ||
        result.request_sha256 !== child.invocation_sha256 ||
        result.exit_code !== child.exit_status ||
        result.stdout !== child.stdout ||
        result.stderr !== child.stderr
      )
        refuse();
    }
    if (
      !normalizedAbsolute(child.config_path) ||
      !normalizedAbsolute(child.fixture_path) ||
      path.basename(child.fixture_path) !== child.file_name ||
      path.dirname(child.fixture_path) !==
        path.join(path.dirname(path.dirname(child.config_path)), "fixtures") ||
      child.stdout_sha256 !== sha256(child.stdout) ||
      child.stderr_sha256 !== sha256(child.stderr) ||
      Buffer.byteLength(child.stdout) > P10_NATIVE_STREAM_BYTES ||
      Buffer.byteLength(child.stderr) > P10_NATIVE_STREAM_BYTES ||
      (child.invocation_json === null) !== (child.invocation_sha256 === null) ||
      (child.invocation_json !== null && sha256(child.invocation_json) !== child.invocation_sha256)
    )
      refuse();
  }
  return collection;
}
export function scaP10NativeAggregateDigests(collection: ScaP10NativeCollectionV1) {
  return {
    invocation_sha256: sha256(canonicalJson(collection.children.map((c) => c.invocation_sha256))),
    raw_result_sha256: sha256(canonicalJson(collection)),
  };
}
export function scaP10NativeCaseV1(child: ScaP10NativeChildV1, expected: string) {
  const native = observeScaP10NativeChildV1(child);
  const observed =
    child.case_class === "broader_regression"
      ? native.observed === null
        ? null
        : native.passed
          ? ("within_bound" as const)
          : ("regression" as const)
      : native.observed;
  return {
    observed_outcome: observed,
    status:
      observed === null
        ? ("unrun" as const)
        : native.passed && observed === expected
          ? ("passed" as const)
          : ("failed" as const),
  };
}

interface NativeTestEvidence {
  readonly collection: ScaP10NativeCollectionV1 | null;
  readonly invocation_sha256: string | null;
  readonly raw_result_sha256: string | null;
  readonly exit_status: number | null;
  readonly status: "passed" | "failed";
}
const expectations: Readonly<Record<string, string>> = {
  vulnerable: "match",
  fixed: "no_match",
  negative_neighbor: "no_match",
  generalized: "match",
  retained_vulnerable: "match",
  held_out: "match",
  broader_regression: "within_bound",
  performance: "within_bound",
};
export function scaP10NativeCollectionComplete(collection: ScaP10NativeCollectionV1): boolean {
  return collection.children.every((child) =>
    child.case_class === "performance"
      ? observeScaP10NativeChildV1(child).passed
      : scaP10NativeCaseV1(child, expectations[child.case_class] ?? "invalid").status === "passed"
  );
}
export function scaP10NativeCollectionExit(collection: ScaP10NativeCollectionV1): number | null {
  return collection.children.every((c) => c.exit_status === 0)
    ? 0
    : (collection.children.find((c) => c.exit_status !== 0)?.exit_status ?? null);
}
/** Independently used by result and manifest admission; retained raw reports are the authority. */
export function validateScaP10NativeTestEvidenceV1(
  test: NativeTestEvidence,
  cases: readonly {
    readonly case_class: string;
    readonly status: string;
    readonly observed_outcome: string | null;
  }[]
): void {
  if (test.collection === null) {
    if (
      test.status !== "failed" ||
      test.invocation_sha256 !== null ||
      test.raw_result_sha256 !== null ||
      test.exit_status !== null ||
      cases.some((c) => c.status !== "unrun" || c.observed_outcome !== null)
    )
      refuse();
    return;
  }
  const collection = validateScaP10NativeCollectionV1(test.collection);
  const digests = scaP10NativeAggregateDigests(collection);
  if (
    test.invocation_sha256 !== digests.invocation_sha256 ||
    test.raw_result_sha256 !== digests.raw_result_sha256 ||
    test.exit_status !== scaP10NativeCollectionExit(collection) ||
    test.status !== (scaP10NativeCollectionComplete(collection) ? "passed" : "failed")
  )
    refuse();
  for (const child of collection.children) {
    if (!(child.case_class in expectations)) refuse();
    if (child.case_class === "performance") continue;
    const actual = cases.find((c) => c.case_class === child.case_class);
    const derived = scaP10NativeCaseV1(child, expectations[child.case_class] ?? "invalid");
    if (
      actual === undefined ||
      derived.status !== actual.status ||
      derived.observed_outcome !== actual.observed_outcome
    )
      refuse();
  }
}
