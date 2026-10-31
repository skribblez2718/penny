/** Ordinary host-only empirical learning. No activation, provider, campaign state or mutable head.
 * Host callbacks are capabilities, never values supplied by model output. See exported schemas.
 */
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Type } from "typebox";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import { parseSealedScaSourceCorpusV1 } from "../../orchestration/dist/sca/active-compliance.js";
import { repositoryPath, verifyPointer } from "../../orchestration/dist/sca/ordinary-artifacts.js";
import {
  parseScaP10NativeJson,
  observeScaP10NativeChildV1,
} from "../../orchestration/dist/sca/p10-native-tests.js";
import {
  ScaProcessResultV1Schema,
  type ScaProcessRequestV1,
  type ScaProcessResultV1,
} from "./process.js";
import {
  absolutePath,
  privateStage,
  readCapturedFile,
  readExactFile,
  writeNewFile,
  publishRuleRelease,
} from "./ordinary-rule-learning-io.js";
import {
  ScaRuleLearningRequestSchema,
  ScaRuleLearningHostAdmissionSchema,
  ScaRuleLearningResultSchema,
  ScaRuleLearningRecordSchema,
  ScaRuleLearningProcessReceiptSchema,
  ScaRulePromotionRequestSchema,
  ScaLearnedRuleReleaseSchema,
  ScaRulePromotionResultSchema,
  ScaRuleRollbackRequestSchema,
  ScaRuleRescanRequestSchema,
  ScaRuleRescanResultSchema,
  type ScaRuleLearningRequest,
  type ScaRuleLearningHostAdmission,
  type ScaRuleLearningResult,
  type ScaRuleLearningRecord,
  type ScaRuleLearningProcessReceipt,
  type ScaRulePromotionRequest,
  type ScaLearnedRuleRelease,
  type ScaRulePromotionResult,
  type ScaRuleRollbackRequest,
  type ScaRuleRescanRequest,
  type ScaRuleRescanResult,
} from "./ordinary-rule-learning-contracts.js";
import {
  captureOfflineMetachecks,
  offlineValidationInvocation,
  offlineCorePassed,
} from "./ordinary-rule-learning-offline.js";
export * from "./ordinary-rule-learning-contracts.js";

export interface OrdinaryRuleLearningHost {
  /** Existing owner must verify exact reconciled confirmed evidence AND independently reviewed
   * fixture truth, exact source bytes/pointers and the ENTIRE approved offline interpreter/core/
   * metacheck manifest (not a caller-selected subset), not merely echo
   * request labels. Called again before publication/adoption/rollback/rescan, including for
   * retained records; the owner must resolve the same exact source/evidence/truth and pins.
   * No default / model-call implementation. */
  admitValidation(
    request: ScaRuleLearningRequest,
    requestSha256: string
  ): Promise<ScaRuleLearningHostAdmission>;
  /** Separately enforce explicit caller authority, namespace, exact predecessor/successor revision
   * and operation identity. Rescan admission also resolves the release's promotion receipt. */
  authorize(
    operation: "promote" | "rescan" | "rollback",
    request: ScaRulePromotionRequest | ScaRuleRescanRequest | ScaRuleRollbackRequest,
    requestSha256: string
  ): Promise<boolean>;
  /** Use the current descriptor-bound process runner under independently enforced offline egress.
   * No fallback: this module cannot infer containment from environment flags or a boolean label.
   * Host enforces any required OS limits; CLI memory/jobs are not a hostile-execution sandbox. */
  runOffline(request: ScaProcessRequestV1, signal?: AbortSignal): Promise<ScaProcessResultV1>;
  /** Mandatory restricted retention BEFORE parsing; never project these receipts into model/public outputs. */
  recordPrivate(receipt: ScaRuleLearningProcessReceipt): Promise<void>;
  recordValidation(record: ScaRuleLearningRecord): Promise<void>;
  /** Exact existing artifact owner read; never accept a model-supplied validation result. */
  readValidation(resultSha256: string): Promise<ScaRuleLearningRecord>;
  /** Caller-selected existing owner-private scratch root, unrelated to source and release namespace. */
  workRoot: string;
}
export interface RuleLearningControl {
  readonly signal?: AbortSignal;
}
const closed = { additionalProperties: false } as const;
const REQUIRED_CLASSES = [
  "vulnerable",
  "fixed",
  "negative_neighbor",
  "benign",
  "generalized",
  "retained_vulnerable",
  "held_out",
  "broader_regression",
  "performance",
];
const NEGATIVE_CLASSES = new Set(["fixed", "negative_neighbor", "benign"]);
// A deliberately non-executing Semgrep JSON search-rule profile, not a YAML loader, plugin,
// validator, join/extract engine or target harness. Unsupported rule forms fail closed.
const RuleSchema = Type.Object(
  {
    rules: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 256 }),
          languages: Type.Array(Type.String(), { minItems: 1, maxItems: 1 }),
          message: Type.String({ minLength: 1, maxLength: 16384 }),
          severity: Type.Union([
            Type.Literal("INFO"),
            Type.Literal("WARNING"),
            Type.Literal("ERROR"),
          ]),
          pattern: Type.String({ minLength: 1, maxLength: 65536 }),
          metadata: Type.Optional(
            Type.Object(
              {
                category: Type.String({ minLength: 1, maxLength: 64 }),
                technology: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
                  minItems: 1,
                  maxItems: 32,
                }),
              },
              closed
            )
          ),
        },
        closed
      ),
      { minItems: 1, maxItems: 1 }
    ),
  },
  closed
);
const ScanSchema = Type.Object(
  {
    version: Type.String(),
    results: Type.Array(
      Type.Object(
        {
          check_id: Type.String(),
          path: Type.String(),
          start: Type.Object(
            { line: Type.Integer({ minimum: 1 }) },
            { additionalProperties: true }
          ),
          end: Type.Object({ line: Type.Integer({ minimum: 1 }) }, { additionalProperties: true }),
        },
        { additionalProperties: true }
      ),
      { maxItems: 32768 }
    ),
    errors: Type.Array(Type.Unknown(), { maxItems: 32768 }),
    paths: Type.Object(
      {
        scanned: Type.Array(Type.String(), { maxItems: 100000 }),
        skipped: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 100000 })),
      },
      { additionalProperties: true }
    ),
    skipped_rules: Type.Array(Type.Unknown(), { maxItems: 32768 }),
  },
  { additionalProperties: true }
);
function same(a: unknown, b: unknown) {
  return canonicalJson(a) === canonicalJson(b);
}
function hashed(value: unknown) {
  return sha256(canonicalJson(value));
}
function decode(value: string, digest: string, maximum: number): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (
    !bytes.length ||
    bytes.toString("base64") !== value ||
    bytes.length > maximum ||
    sha256(bytes) !== digest
  )
    throw new Error("input_bytes_drift");
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return bytes;
}
function checkRule(bytes: Buffer, ruleId: string, language: string) {
  const parsed = validateContract(
    RuleSchema,
    parseScaP10NativeJson(bytes.toString("utf8")),
    "Inert Semgrep search rule"
  );
  const rule = parsed.rules[0];
  if (rule === undefined || rule.id !== ruleId || !same(rule.languages, [language]))
    throw new Error("candidate_identity_drift");
}
function bindCorpus(
  request: {
    source_snapshot_sha256: string;
    source_corpus_sha256: string;
    limits: ScaRuleLearningRequest["limits"];
  },
  corpus: Buffer
) {
  if (
    corpus.length > request.limits.max_input_bytes ||
    sha256(corpus) !== request.source_corpus_sha256
  )
    throw new Error("source_corpus_drift");
  const parsed = parseSealedScaSourceCorpusV1(corpus);
  if (
    parsed.source_snapshot_sha256 !== request.source_snapshot_sha256 ||
    parsed.excluded_paths.size
  )
    throw new Error("source_snapshot_or_coverage_drift");
  for (const file of parsed.files.values())
    if (!repositoryPath(file.path) || file.bytes.length > request.limits.max_file_bytes)
      throw new Error("source_path_or_size");
  return parsed;
}
function bindRequest(request: ScaRuleLearningRequest, corpus: Buffer): Buffer | null {
  absolutePath(request.baseline.rules_path);
  absolutePath(request.tool.executable);
  const source = bindCorpus(request, corpus);
  for (const pointer of request.evidence_pointers) verifyPointer(source, pointer);
  return bindCandidate(request);
}
/** Rechecked from retained request bytes before every consequential replay. Source bytes and
 * confirmed evidence are resolved independently by the trusted admission owner, not a summary. */
function bindCandidate(request: ScaRuleLearningRequest): Buffer | null {
  if (request.candidate !== null && request.baseline.rule_ids.includes(request.candidate.rule_id))
    throw new Error("candidate_must_not_replace_retained_rule");
  if (hashed(request.fixtures) !== request.fixture_truth_sha256)
    throw new Error("fixture_truth_drift");
  if (request.candidate === null) {
    if (request.no_rule_reason === null || request.fixtures.length)
      throw new Error("no_rule_assessment_missing");
    return null;
  }
  if (request.no_rule_reason !== null) throw new Error("contradictory_no_rule");
  absolutePath(request.candidate.rules_path);
  if (request.candidate.rules_path === request.baseline.rules_path)
    throw new Error("candidate_baseline_overlap");
  if (
    new Set(request.fixtures.map((f) => f.id)).size !== request.fixtures.length ||
    new Set(request.fixtures.map((f) => f.file_name)).size !== request.fixtures.length
  )
    throw new Error("duplicate_fixtures");
  if (REQUIRED_CLASSES.some((c) => !request.fixtures.some((f) => f.case_class === c)))
    throw new Error("required_fixture_missing");
  if (
    request.limits.max_processes <
    (request.offline_validation === undefined ? 1 : 2) + 2 * request.fixtures.length
  )
    throw new Error("process_budget_insufficient");
  let size = 0;
  for (const fixture of request.fixtures) {
    const bytes = decode(
        fixture.content_base64,
        fixture.content_sha256,
        request.limits.max_file_bytes
      ),
      text = bytes.toString("utf8").split("\n");
    size += bytes.length;
    if (
      fixture.baseline_matches.some(
        (m) => !request.baseline.rule_ids.includes(m.rule_id) || m.line > text.length
      ) ||
      new Set(fixture.baseline_matches.map((m) => `${m.rule_id}:${m.line}`)).size !==
        fixture.baseline_matches.length
    )
      throw new Error("baseline_fixture_assertion_drift");
    const expectedExtension =
      request.candidate.language === "php"
        ? ".php"
        : request.candidate.language === "javascript"
          ? ".js"
          : ".ts";
    if (!fixture.file_name.endsWith(expectedExtension) || fixture.control_lines.length === 0)
      throw new Error("fixture_language_or_control_missing");
    const assertions = fixture.assertions.map((a) => a.line);
    if (
      new Set([...fixture.control_lines, ...assertions]).size !==
      fixture.control_lines.length + assertions.length
    )
      throw new Error("duplicate_fixture_assertions");
    if (
      NEGATIVE_CLASSES.has(fixture.case_class)
        ? fixture.assertions.some((a) => a.match)
        : !fixture.assertions.some((a) => a.match)
    )
      throw new Error("case_assertion_contradiction");
    const expected = new Map([
      ...fixture.control_lines.map((line) => [line, true] as const),
      ...fixture.assertions.map((a) => [a.line, a.match] as const),
    ]);
    for (const [line, match] of expected)
      if (
        line < 2 ||
        line > text.length ||
        text[line - 2]?.trim() !== `// ${match ? "ruleid" : "ok"}: ${request.candidate.rule_id}`
      )
        throw new Error("fixture_annotation_drift");
    // Every annotation is predeclared; nothing inferred from scanner results.
    for (let index = 0; index < text.length; index++)
      if (/^\s*\/\/\s*(?:ruleid|ok):/u.test(text[index] ?? "") && !expected.has(index + 2))
        throw new Error("undeclared_annotation");
  }
  const rule = readExactFile(
    request.candidate.rules_path,
    request.limits.max_file_bytes,
    request.candidate.rules_sha256
  );
  if (size + rule.length > request.limits.max_input_bytes) throw new Error("input_budget_exceeded");
  checkRule(rule, request.candidate.rule_id, request.candidate.language);
  return rule;
}
function environment(cwd: string, libraryDirectory?: string): ScaProcessRequestV1["environment"] {
  return [
    { name: "HOME", value: cwd },
    { name: "PATH", value: "/usr/bin:/bin" },
    { name: "SEMGREP_ENABLE_VERSION_CHECK", value: "0" },
    { name: "SEMGREP_SEND_METRICS", value: "off" },
    // Full --validate in some releases still wants remote metachecks. Unsupported file scheme
    // refuses that acquisition without DNS/HTTP; it is NOT an offline metacheck substitute.
    { name: "SEMGREP_URL", value: "file:///offline-rule-registry-disabled" },
    ...(libraryDirectory === undefined
      ? []
      : [{ name: "LD_LIBRARY_PATH", value: libraryDirectory }]),
  ];
}
function args(
  kind: ScaRuleLearningProcessReceipt["kind"],
  config: string,
  targets: string[],
  memory: number
) {
  const common = [
    "scan",
    "--metrics=off",
    "--disable-version-check",
    "--no-git-ignore",
    "--json",
    "--jobs",
    "1",
    "--max-memory",
    String(memory),
    "--config",
    config,
  ];
  if (kind === "validate") return [...common, "--validate"];
  if (kind === "validate_schema") throw new Error("offline_schema_invocation_required");
  if (kind === "test") return [...common, "--test", "--", ...targets];
  return [
    ...common,
    "--config",
    path.join(path.dirname(config), "baseline.yml"),
    "--error",
    "--strict",
    "--disable-nosem",
    "--no-rewrite-rule-ids",
    "--x-ignore-semgrepignore-files",
    "--",
    ...targets,
  ];
}
function complete(result: ScaProcessResultV1): boolean {
  return (
    result.signal === null &&
    !result.stdout_truncated &&
    !result.stderr_truncated &&
    ((result.status === "succeeded" && result.exit_code === 0 && result.failure_code === "none") ||
      (result.status === "nonzero_exit" &&
        result.exit_code === 1 &&
        result.failure_code === "nonzero_exit"))
  );
}
function checkReceipt(receipt: ScaRuleLearningProcessReceipt): void {
  const r = receipt.result;
  if (
    r.request_sha256 !== hashed(receipt.invocation) ||
    r.stdout_bytes !== Buffer.byteLength(r.stdout) ||
    r.stderr_bytes !== Buffer.byteLength(r.stderr) ||
    r.stdout_sha256 !== sha256(r.stdout) ||
    r.stderr_sha256 !== sha256(r.stderr) ||
    r.stdout_bytes > receipt.invocation.max_stdout_bytes ||
    r.stderr_bytes > receipt.invocation.max_stderr_bytes
  )
    throw new Error("private_process_receipt_drift");
}
function scan(
  receipt: ScaRuleLearningProcessReceipt,
  toolVersion: string,
  ruleIds: string[],
  targets: string[]
) {
  if (!complete(receipt.result)) throw new Error("scan_incomplete");
  const report = validateContract(
    ScanSchema,
    parseScaP10NativeJson(receipt.result.stdout),
    "Native Semgrep scan"
  );
  if (
    report.version !== toolVersion ||
    report.errors.length ||
    report.skipped_rules.length ||
    (report.paths.skipped?.length ?? 0) ||
    !same([...report.paths.scanned].sort(), [...targets].sort()) ||
    receipt.result.exit_code !== (report.results.length ? 1 : 0)
  )
    throw new Error("scan_coverage_or_exit_drift");
  for (const finding of report.results)
    if (
      !ruleIds.includes(finding.check_id) ||
      !targets.includes(finding.path) ||
      finding.end.line < finding.start.line
    )
      throw new Error("scan_result_identity_drift");
  return report.results;
}
function derive(
  request: ScaRuleLearningRequest,
  receipts: ScaRuleLearningProcessReceipt[],
  baselineUnchanged: boolean
): ScaRuleLearningResult {
  const requestSha = hashed(request),
    candidate = request.candidate;
  const validation = receipts.find((r) => r.kind === "validate");
  let validationPassed = false;
  const schema = receipts.find((r) => r.kind === "validate_schema");
  // Legacy CLI-only receipts are diagnostic evidence, NEVER full validation. No-rule
  // assessments remain representable without granting candidate publication authority.
  if (
    request.offline_validation !== undefined &&
    validation !== undefined &&
    schema !== undefined
  ) {
    try {
      validationPassed =
        complete(validation.result) &&
        validation.result.exit_code === 0 &&
        complete(schema.result) &&
        schema.result.exit_code === 0 &&
        schema.result.stdout === "" &&
        schema.result.stderr === "" &&
        offlineCorePassed(validation.result.stdout, validation.result.stderr, request.tool.version);
    } catch {
      /* Missing/malformed/zero-check/skipped output is not validation evidence. */
    }
  }
  for (const receipt of receipts) {
    checkReceipt(receipt);
    absolutePath(receipt.workspace_path);
    if (path.basename(receipt.workspace_path) !== path.basename(receipt.invocation.cwd))
      throw new Error("workspace_binding_drift");
    if (receipt.request_sha256 !== requestSha || receipt.kind === "rescan" || candidate === null)
      throw new Error("validation_receipt_binding");
    const cwd = receipt.invocation.cwd,
      fixture = request.fixtures.find((f) => f.id === receipt.fixture_id);
    if (
      ["validate", "validate_schema"].includes(receipt.kind) !== (receipt.fixture_id === null) ||
      (!["validate", "validate_schema"].includes(receipt.kind) && fixture === undefined)
    )
      throw new Error("fixture_receipt_binding");
    const targets = fixture === undefined ? [] : [path.join(cwd, "fixtures", fixture.file_name)];
    const offline =
      request.offline_validation !== undefined &&
      ["validate", "validate_schema"].includes(receipt.kind)
        ? offlineValidationInvocation(request, cwd, receipt.kind === "validate_schema")
        : undefined;
    if (
      receipt.invocation.executable !== (offline?.tool ?? request.tool).executable ||
      receipt.invocation.executable_sha256 !== (offline?.tool ?? request.tool).sha256 ||
      !same(receipt.invocation.environment, environment(cwd, offline?.library_directory)) ||
      !same(
        receipt.invocation.arguments,
        offline?.arguments ??
          args(
            receipt.kind,
            path.join(cwd, "candidate.json"),
            targets,
            request.limits.max_memory_mb
          )
      ) ||
      receipt.invocation.timeout_ms !== request.limits.inactivity_ms ||
      receipt.invocation.max_stdout_bytes !== request.limits.max_output_bytes ||
      receipt.invocation.max_stderr_bytes !== request.limits.max_output_bytes
    )
      throw new Error("invocation_binding_drift");
  }
  if (new Set(receipts.map((r) => `${r.kind}:${r.fixture_id ?? ""}`)).size !== receipts.length)
    throw new Error("duplicate_process_receipts");
  const cases: ScaRuleLearningResult["cases"] = request.fixtures.map((fixture) => {
    const tested = receipts.find((r) => r.kind === "test" && r.fixture_id === fixture.id),
      scanned = receipts.find((r) => r.kind === "scan" && r.fixture_id === fixture.id);
    let testPassed = false,
      scanComplete = false,
      baselineMatchesPassed = false,
      reported: number[] = [];
    if (candidate !== null && tested !== undefined) {
      const config = path.join(tested.invocation.cwd, "candidate.json"),
        fixturePath = path.join(tested.workspace_path, "fixtures", fixture.file_name);
      testPassed = observeScaP10NativeChildV1({
        case_class: fixture.case_class,
        file_name: fixture.file_name,
        fixture_sha256: fixture.content_sha256,
        source_base64: fixture.content_base64,
        rule_id: candidate.rule_id,
        config_path: config,
        config_source_base64: "",
        config_sha256: candidate.rules_sha256,
        fixture_path: fixturePath,
        invocation_json: canonicalJson(tested.invocation),
        invocation_sha256: tested.result.request_sha256,
        process_result_json: canonicalJson(tested.result),
        exit_status: tested.result.exit_code,
        completed: complete(tested.result),
        stdout: tested.result.stdout,
        stderr: tested.result.stderr,
        stdout_sha256: tested.result.stdout_sha256,
        stderr_sha256: tested.result.stderr_sha256,
      }).passed;
    }
    if (candidate !== null && scanned !== undefined) {
      try {
        const observations = scan(
          scanned,
          request.tool.version,
          [candidate.rule_id, ...request.baseline.rule_ids],
          [path.join(scanned.invocation.cwd, "fixtures", fixture.file_name)]
        );
        reported = observations
          .filter((r) => r.check_id === candidate.rule_id)
          .map((r) => r.start.line);
        const retained = observations
          .filter((r) => r.check_id !== candidate.rule_id)
          .map((r) => ({ rule_id: r.check_id, line: r.start.line }));
        baselineMatchesPassed = same(
          retained.map((m) => `${m.rule_id}:${m.line}`).sort(),
          fixture.baseline_matches.map((m) => `${m.rule_id}:${m.line}`).sort()
        );
        if (
          new Set(reported).size !== reported.length ||
          reported.some(
            (line) =>
              line >
              Buffer.from(fixture.content_base64, "base64").toString("utf8").split("\n").length
          )
        )
          throw new Error("duplicate_or_invalid_scan_line");
        scanComplete = true;
      } catch {
        /* Never interpret malformed, partial, skipped or failed scans as no-match. */
      }
    }
    const expected = [
      ...fixture.control_lines,
      ...fixture.assertions.filter((a) => a.match).map((a) => a.line),
    ].sort((a, b) => a - b);
    const assertions = fixture.assertions.map((a) => ({
      line: a.line,
      expected: a.match,
      observed: scanComplete ? reported.includes(a.line) : null,
    }));
    const unexpected = scanComplete
      ? reported.filter((line) => !expected.includes(line)).sort((a, b) => a - b)
      : [];
    return {
      fixture_id: fixture.id,
      case_class: fixture.case_class,
      status:
        !scanComplete || tested === undefined
          ? "unrun"
          : testPassed &&
              baselineMatchesPassed &&
              same(
                [...reported].sort((a, b) => a - b),
                expected
              )
            ? "passed"
            : "failed",
      test_passed: testPassed,
      scan_complete: scanComplete,
      baseline_matches_passed: baselineMatchesPassed,
      assertions,
      unexpected_lines: unexpected,
      elapsed_ms:
        scanned === undefined || tested === undefined
          ? null
          : scanned.elapsed_ms + tested.elapsed_ms,
    };
  });
  const elapsed = receipts.reduce((total, r) => total + r.elapsed_ms, 0);
  const performancePassed =
    receipts.length ===
      (request.offline_validation === undefined ? 1 : 2) + 2 * request.fixtures.length &&
    cases.every((c) => c.status === "passed") &&
    elapsed <= request.limits.performance_bound_ms;
  const reasons: string[] = [];
  if (candidate !== null && request.offline_validation === undefined)
    reasons.push("full_offline_validation_pins_required_schema_core_entire_admitted_metachecks");
  if (!validationPassed) reasons.push("semgrep_validate_failed_or_unrun");
  for (const c of cases) if (c.status !== "passed") reasons.push(`${c.fixture_id}:${c.status}`);
  if (!performancePassed) reasons.push("performance_failed_or_unrun");
  if (!baselineUnchanged) reasons.push("baseline_drift");
  const success =
    validationPassed &&
    cases.length > 0 &&
    cases.every((c) => c.status === "passed") &&
    performancePassed &&
    baselineUnchanged;
  const body = {
    schema_version: 1 as const,
    request_sha256: requestSha,
    status: success ? ("validated" as const) : ("quarantined" as const),
    reasons: success ? ["all_declared_assertions_passed"] : reasons,
    baseline_unchanged: baselineUnchanged,
    validation_passed: validationPassed,
    cases,
    elapsed_ms: elapsed,
    performance_passed: performancePassed,
    private_receipts_sha256: hashed(receipts),
  };
  return validateContract(
    ScaRuleLearningResultSchema,
    { ...body, result_sha256: hashed(body) },
    "Empirical learning result"
  );
}
function admitted(
  request: ScaRuleLearningRequest,
  admission: ScaRuleLearningHostAdmission
): boolean {
  if (
    admission.request_sha256 !== hashed(request) ||
    admission.reconciliation_sha256 !== request.reconciliation_sha256 ||
    admission.hypothesis_sha256 !== request.hypothesis_sha256 ||
    admission.disposition_sha256 !== request.disposition_sha256 ||
    admission.evidence_sha256 !== request.evidence_sha256 ||
    admission.fixture_truth_sha256 !== request.fixture_truth_sha256
  )
    throw new Error("host_admission_binding_drift");
  return admission.decision === "allow";
}
function nonpositive(
  request: ScaRuleLearningRequest,
  status: "denied" | "failed" | "not_feasible",
  reason: string,
  baseline: boolean,
  receipts: ScaRuleLearningProcessReceipt[]
): ScaRuleLearningResult {
  let cases: ScaRuleLearningResult["cases"] = [];
  if (receipts.length > 0 && request.candidate !== null) {
    try {
      cases = derive(request, receipts, baseline).cases;
    } catch {
      /* Raw receipts remain private even when binding is invalid. */
    }
  }
  const body = {
    schema_version: 1 as const,
    request_sha256: hashed(request),
    status,
    reasons: [reason],
    baseline_unchanged: baseline,
    validation_passed: false,
    cases,
    elapsed_ms: receipts.reduce((n, r) => n + r.elapsed_ms, 0),
    performance_passed: false,
    private_receipts_sha256: hashed(receipts),
  };
  return validateContract(
    ScaRuleLearningResultSchema,
    { ...body, result_sha256: hashed(body) },
    "Non-positive learning result"
  );
}
export function createOrdinaryRuleLearning(host: OrdinaryRuleLearningHost) {
  async function invoke(
    kind: ScaRuleLearningProcessReceipt["kind"],
    fixtureId: string | null,
    binding: string,
    tool: ScaRuleLearningRequest["tool"],
    limits: ScaRuleLearningRequest["limits"],
    cwd: string,
    config: string,
    targets: string[],
    control: RuleLearningControl,
    offline?: ReturnType<typeof offlineValidationInvocation>
  ): Promise<ScaRuleLearningProcessReceipt> {
    control.signal?.throwIfAborted();
    const invocation: ScaProcessRequestV1 = {
      schema_id: "penny.sca-process-request.v1",
      schema_version: 1,
      executable: (offline?.tool ?? tool).executable,
      executable_sha256: (offline?.tool ?? tool).sha256,
      arguments: offline?.arguments ?? args(kind, config, targets, limits.max_memory_mb),
      cwd,
      environment: environment(cwd, offline?.library_directory),
      timeout_ms: limits.inactivity_ms,
      max_stdout_bytes: limits.max_output_bytes,
      max_stderr_bytes: limits.max_output_bytes,
    };
    const started = performance.now(),
      startedAt = new Date().toISOString();
    const result = validateContract(
      ScaProcessResultV1Schema,
      await host.runOffline(invocation, control.signal),
      "Native process result"
    );
    const receipt = validateContract(
      ScaRuleLearningProcessReceiptSchema,
      {
        kind,
        fixture_id: fixtureId,
        workspace_path: realpathSync(cwd),
        request_sha256: binding,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        elapsed_ms: performance.now() - started,
        invocation,
        result,
      },
      "Private native receipt"
    );
    // Preserve even invalid / contradictory returned receipts before refusing interpretation.
    await host.recordPrivate(receipt);
    checkReceipt(receipt);
    return receipt;
  }
  async function replay(record: ScaRuleLearningRecord): Promise<boolean> {
    const prior = record.request;
    if (
      prior.candidate === null ||
      prior.offline_validation === undefined ||
      record.result.status !== "validated" ||
      !admitted(prior, record.admission)
    )
      return false;
    // A retained allow label or recomputed summary digest cannot self-authorize full validation.
    const current = validateContract(
      ScaRuleLearningHostAdmissionSchema,
      await host.admitValidation(prior, hashed(prior)),
      "Re-admitted exact validation inputs"
    );
    if (!admitted(prior, current)) return false;
    bindCandidate(prior);
    captureOfflineMetachecks(prior);
    readExactFile(
      prior.baseline.rules_path,
      prior.limits.max_file_bytes,
      prior.baseline.rules_sha256
    );
    return same(derive(prior, record.receipts, true), record.result);
  }
  function releaseMatches(record: ScaRuleLearningRecord, release: ScaLearnedRuleRelease): boolean {
    const prior = record.request,
      candidate = prior.candidate;
    return (
      candidate !== null &&
      record.result.result_sha256 === release.validation_sha256 &&
      record.result.private_receipts_sha256 === release.private_receipts_sha256 &&
      prior.source_snapshot_sha256 === release.source_snapshot_sha256 &&
      prior.source_corpus_sha256 === release.source_corpus_sha256 &&
      prior.reconciliation_sha256 === release.reconciliation_sha256 &&
      prior.hypothesis_sha256 === release.hypothesis_sha256 &&
      prior.fixture_truth_sha256 === release.fixture_truth_sha256 &&
      same(prior.tool, release.tool) &&
      same(prior.offline_validation, release.offline_validation) &&
      candidate.rule_id === release.rule_id &&
      candidate.language === release.language &&
      candidate.rules_sha256 === release.rule_sha256 &&
      prior.baseline.rules_sha256 === release.retained_rule_sha256 &&
      same(prior.baseline.rule_ids, release.retained_rule_ids)
    );
  }
  return {
    async validate(
      value: unknown,
      corpus: Buffer,
      control: RuleLearningControl = {}
    ): Promise<ScaRuleLearningResult> {
      const request = validateContract(
        ScaRuleLearningRequestSchema,
        value,
        "Ordinary learning request"
      );
      const admission = validateContract(
        ScaRuleLearningHostAdmissionSchema,
        await host.admitValidation(request, hashed(request)),
        "Host learning admission"
      );
      const receipts: ScaRuleLearningProcessReceipt[] = [];
      let result: ScaRuleLearningResult,
        baseline = false;
      let stage: ReturnType<typeof privateStage> | undefined;
      try {
        if (!admitted(request, admission))
          result = nonpositive(
            request,
            "denied",
            "host_denied_eligibility_or_fixture_truth",
            false,
            receipts
          );
        else {
          control.signal?.throwIfAborted();
          const rule = bindRequest(request, corpus);
          const baselineBytes = readExactFile(
            request.baseline.rules_path,
            request.limits.max_file_bytes,
            request.baseline.rules_sha256
          );
          if (
            corpus.length +
              baselineBytes.length +
              (rule?.length ?? 0) +
              request.fixtures.reduce(
                (sum, fixture) => sum + Buffer.from(fixture.content_base64, "base64").length,
                0
              ) >
            request.limits.max_input_bytes
          )
            throw new Error("combined_input_budget_exceeded");
          const metachecks = rule === null ? undefined : captureOfflineMetachecks(request);
          if (
            metachecks !== undefined &&
            corpus.length +
              baselineBytes.length +
              (rule?.length ?? 0) * 2 +
              metachecks.length +
              request.fixtures.reduce(
                (sum, f) => sum + Buffer.from(f.content_base64, "base64").length,
                0
              ) >
              request.limits.max_input_bytes
          )
            throw new Error("offline_input_budget_exceeded");
          baseline = true;
          if (rule === null)
            result = nonpositive(
              request,
              "not_feasible",
              "host_admitted_evidence_backed_no_rule_assessment",
              true,
              receipts
            );
          else {
            stage = privateStage(host.workRoot);
            const config = path.join(stage.root, "candidate.json"),
              fixtures = path.join(stage.root, "fixtures");
            mkdirSync(fixtures, { mode: 0o700 });
            writeNewFile(config, rule);
            if (metachecks !== undefined) {
              // Native -check_rules enumerates YAML only: JSON bytes remain unchanged, but
              // the validation copy must have .yaml or core silently checks zero rules.
              writeNewFile(path.join(stage.root, "candidate.yaml"), rule);
              writeNewFile(path.join(stage.root, "metachecks.json"), metachecks);
            }
            writeNewFile(path.join(stage.root, "baseline.yml"), baselineBytes);
            for (const fixture of request.fixtures)
              writeNewFile(
                path.join(fixtures, fixture.file_name),
                Buffer.from(fixture.content_base64, "base64")
              );
            const stable = () => {
              if (metachecks !== undefined) {
                readCapturedFile(
                  path.join(path.dirname(config), "candidate.yaml"),
                  request.limits.max_file_bytes,
                  request.candidate?.rules_sha256
                );
                readCapturedFile(
                  path.join(path.dirname(config), "metachecks.json"),
                  request.limits.max_file_bytes,
                  sha256(metachecks)
                );
                captureOfflineMetachecks(request);
              }
              readCapturedFile(
                path.join(path.dirname(config), "baseline.yml"),
                request.limits.max_file_bytes,
                request.baseline.rules_sha256
              );
              readCapturedFile(
                config,
                request.limits.max_file_bytes,
                request.candidate?.rules_sha256
              );
              for (const fixture of request.fixtures)
                readCapturedFile(
                  path.join(fixtures, fixture.file_name),
                  request.limits.max_file_bytes,
                  fixture.content_sha256
                );
              readExactFile(
                request.baseline.rules_path,
                request.limits.max_file_bytes,
                request.baseline.rules_sha256
              );
            };
            if (request.offline_validation !== undefined) {
              receipts.push(
                await invoke(
                  "validate_schema",
                  null,
                  hashed(request),
                  request.tool,
                  request.limits,
                  stage.root,
                  config,
                  [],
                  control,
                  offlineValidationInvocation(request, stage.root, true)
                )
              );
              stable();
            }
            receipts.push(
              await invoke(
                "validate",
                null,
                hashed(request),
                request.tool,
                request.limits,
                stage.root,
                config,
                [],
                control,
                request.offline_validation === undefined
                  ? undefined
                  : offlineValidationInvocation(request, stage.root, false)
              )
            );
            stable();
            // Keep actual case evidence even when --validate is unavailable offline; never promote it.
            for (const fixture of request.fixtures)
              for (const kind of ["test", "scan"] as const) {
                control.signal?.throwIfAborted();
                stable();
                receipts.push(
                  await invoke(
                    kind,
                    fixture.id,
                    hashed(request),
                    request.tool,
                    request.limits,
                    stage.root,
                    config,
                    [path.join(fixtures, fixture.file_name)],
                    control
                  )
                );
                stable();
              }
            result = derive(request, receipts, true);
          }
        }
      } catch {
        try {
          readExactFile(
            request.baseline.rules_path,
            request.limits.max_file_bytes,
            request.baseline.rules_sha256
          );
          baseline = true;
        } catch {
          baseline = false;
        }
        result = nonpositive(
          request,
          "failed",
          control.signal?.aborted ? "cancelled" : "input_process_or_retention_failure",
          baseline,
          receipts
        );
      } finally {
        stage?.dispose();
      }
      await host.recordValidation(
        validateContract(
          ScaRuleLearningRecordSchema,
          { request, result, admission, receipts },
          "Private learning record"
        )
      );
      return result;
    },
    async promote(
      value: unknown,
      control: RuleLearningControl = {},
      fault?: (boundary: string) => void
    ): Promise<ScaRulePromotionResult> {
      const request = validateContract(
          ScaRulePromotionRequestSchema,
          value,
          "Ordinary promotion request"
        ),
        requestSha = hashed(request);
      let baseline = false;
      const outcome = (
        status: ScaRulePromotionResult["status"],
        reason: string,
        releasePath: string | null = null,
        releaseSha: string | null = null
      ) =>
        validateContract(
          ScaRulePromotionResultSchema,
          {
            status,
            reason,
            request_sha256: requestSha,
            release_path: releasePath,
            release_sha256: releaseSha,
            baseline_unchanged: baseline,
          },
          "Promotion outcome"
        );
      if (
        request.authority.decision !== "allow" ||
        !(await host.authorize("promote", request, requestSha))
      )
        return outcome("denied", "separate_explicit_promotion_authority_required");
      try {
        control.signal?.throwIfAborted();
        const record = validateContract(
          ScaRuleLearningRecordSchema,
          await host.readValidation(request.validation_sha256),
          "Exact private validation record"
        );
        const prior = record.request;
        if (
          !admitted(prior, record.admission) ||
          prior.run_id !== request.run_id ||
          record.result.result_sha256 !== request.validation_sha256 ||
          prior.candidate === null ||
          prior.baseline.release_sha256 !== request.predecessor_release_sha256 ||
          record.result.status !== "validated" ||
          !(await replay(record))
        )
          return outcome("denied", "validated_exact_eligible_candidate_required");
        readExactFile(
          prior.baseline.rules_path,
          prior.limits.max_file_bytes,
          prior.baseline.rules_sha256
        );
        baseline = true;
        const rule = readExactFile(
          prior.candidate.rules_path,
          prior.limits.max_file_bytes,
          prior.candidate.rules_sha256
        );
        checkRule(rule, prior.candidate.rule_id, prior.candidate.language);
        captureOfflineMetachecks(prior);
        const release = validateContract(
          ScaLearnedRuleReleaseSchema,
          {
            schema_version: 1,
            kind: "ordinary-sca-learned-rule-release",
            request_sha256: requestSha,
            validation_sha256: request.validation_sha256,
            private_receipts_sha256: record.result.private_receipts_sha256,
            source_snapshot_sha256: prior.source_snapshot_sha256,
            source_corpus_sha256: prior.source_corpus_sha256,
            reconciliation_sha256: prior.reconciliation_sha256,
            hypothesis_sha256: prior.hypothesis_sha256,
            fixture_truth_sha256: prior.fixture_truth_sha256,
            predecessor_release_sha256: prior.baseline.release_sha256,
            predecessor_rules_sha256: prior.baseline.rules_sha256,
            retained_rule_content_base64: readExactFile(
              prior.baseline.rules_path,
              prior.limits.max_file_bytes,
              prior.baseline.rules_sha256
            ).toString("base64"),
            retained_rule_sha256: prior.baseline.rules_sha256,
            retained_rule_ids: prior.baseline.rule_ids,
            successor_revision: request.successor_revision,
            tool: prior.tool,
            ...(prior.offline_validation === undefined
              ? {}
              : { offline_validation: prior.offline_validation }),
            rule_id: prior.candidate.rule_id,
            language: prior.candidate.language,
            rule_content_base64: rule.toString("base64"),
            rule_sha256: sha256(rule),
            authority_sha256: request.authority.authority_sha256,
            future_only: true,
            immutable: true,
          },
          "Immutable future rule release"
        );
        absolutePath(request.namespace);
        if (
          request.namespace === path.dirname(prior.baseline.rules_path) ||
          prior.baseline.rules_path.startsWith(request.namespace + "/") ||
          prior.candidate.rules_path.startsWith(request.namespace + "/")
        )
          return outcome("denied", "release_namespace_input_overlap");
        control.signal?.throwIfAborted();
        const publication = publishRuleRelease({
          namespace: request.namespace,
          slot: hashed({
            predecessor: request.predecessor_release_sha256,
            revision: request.successor_revision,
          }),
          content: Buffer.from(canonicalJson(release)),
          fault(boundary) {
            fault?.(boundary);
            if (boundary === "before_publish") control.signal?.throwIfAborted();
          },
        });
        baseline = false;
        readExactFile(
          prior.baseline.rules_path,
          prior.limits.max_file_bytes,
          prior.baseline.rules_sha256
        );
        baseline = true;
        // No baseline/head update and no rescan call. A separately authorized rollback
        // also appends a future successor; history is never edited here.
        return publication.status === "conflict"
          ? outcome("conflict", "immutable_successor_conflict")
          : outcome(
              publication.status,
              "future_release_only_no_rescan",
              publication.path,
              publication.sha256
            );
      } catch {
        return outcome(
          "failed",
          control.signal?.aborted ? "cancelled" : "promotion_io_or_evidence_failure"
        );
      }
    },
    async rollback(
      value: unknown,
      control: RuleLearningControl = {}
    ): Promise<ScaRulePromotionResult> {
      const request = validateContract(
          ScaRuleRollbackRequestSchema,
          value,
          "Separate immutable rollback request"
        ),
        requestSha = hashed(request);
      let baseline = false;
      const outcome = (
        status: ScaRulePromotionResult["status"],
        reason: string,
        releasePath: string | null = null,
        releaseSha: string | null = null
      ) =>
        validateContract(
          ScaRulePromotionResultSchema,
          {
            status,
            reason,
            request_sha256: requestSha,
            release_path: releasePath,
            release_sha256: releaseSha,
            baseline_unchanged: baseline,
          },
          "Immutable rollback outcome"
        );
      if (
        request.authority.decision !== "allow" ||
        !(await host.authorize("rollback", request, requestSha))
      )
        return outcome("denied", "separate_explicit_rollback_authority_required");
      try {
        control.signal?.throwIfAborted();
        const load = (file: string, digest: string) => {
          if (path.basename(file) !== `${digest}.json`)
            throw new Error("rollback_release_address_drift");
          return validateContract(
            ScaLearnedRuleReleaseSchema,
            parseScaP10NativeJson(
              readExactFile(file, request.limits.max_input_bytes, digest).toString("utf8")
            ),
            "Exact retained release"
          );
        };
        const predecessor = load(
            request.predecessor_release_path,
            request.predecessor_release_sha256
          ),
          restored = load(request.restore_release_path, request.restore_release_sha256);
        if (
          request.successor_revision !== predecessor.successor_revision + 1 ||
          restored.successor_revision >= request.successor_revision
        )
          return outcome("denied", "rollback_revision_must_be_future_only");
        const record = validateContract(
          ScaRuleLearningRecordSchema,
          await host.readValidation(restored.validation_sha256),
          "Retained validated rule record"
        );
        if (
          record.result.result_sha256 !== restored.validation_sha256 ||
          !admitted(record.request, record.admission) ||
          record.result.status !== "validated" ||
          !(await replay(record)) ||
          !releaseMatches(record, restored) ||
          record.request.candidate?.rules_sha256 !== restored.rule_sha256 ||
          record.request.baseline.rules_sha256 !== restored.retained_rule_sha256 ||
          !same(record.request.baseline.rule_ids, restored.retained_rule_ids) ||
          record.result.private_receipts_sha256 !== restored.private_receipts_sha256
        )
          return outcome("denied", "rollback_target_requires_retained_validation");
        readExactFile(
          record.request.baseline.rules_path,
          request.limits.max_file_bytes,
          record.request.baseline.rules_sha256
        );
        baseline = true;
        const rule = decode(
          restored.rule_content_base64,
          restored.rule_sha256,
          request.limits.max_file_bytes
        );
        checkRule(rule, restored.rule_id, restored.language);
        decode(
          restored.retained_rule_content_base64,
          restored.retained_rule_sha256,
          request.limits.max_file_bytes
        );
        const successor = validateContract(
          ScaLearnedRuleReleaseSchema,
          {
            ...restored,
            request_sha256: requestSha,
            predecessor_release_sha256: request.predecessor_release_sha256,
            predecessor_rules_sha256: predecessor.rule_sha256,
            successor_revision: request.successor_revision,
            authority_sha256: request.authority.authority_sha256,
            restored_from_release_sha256: request.restore_release_sha256,
          },
          "Future-only restoration successor"
        );
        control.signal?.throwIfAborted();
        const publication = publishRuleRelease({
          namespace: request.namespace,
          slot: hashed({
            predecessor: request.predecessor_release_sha256,
            revision: request.successor_revision,
          }),
          content: Buffer.from(canonicalJson(successor)),
        });
        baseline = false;
        readExactFile(
          record.request.baseline.rules_path,
          request.limits.max_file_bytes,
          record.request.baseline.rules_sha256
        );
        baseline = true;
        return publication.status === "conflict"
          ? outcome("conflict", "immutable_successor_conflict")
          : outcome(
              publication.status,
              "future_only_rollback_no_rescan_or_baseline_mutation",
              publication.path,
              publication.sha256
            );
      } catch {
        return outcome(
          "failed",
          control.signal?.aborted ? "cancelled" : "rollback_io_or_evidence_failure"
        );
      }
    },
    async rescan(
      value: unknown,
      corpus: Buffer,
      control: RuleLearningControl = {}
    ): Promise<ScaRuleRescanResult> {
      const request = validateContract(
          ScaRuleRescanRequestSchema,
          value,
          "Separate rescan request"
        ),
        requestSha = hashed(request);
      const receipts: ScaRuleLearningProcessReceipt[] = [];
      const outcome = (
        status: ScaRuleRescanResult["status"],
        reason: string,
        findings: ScaRuleRescanResult["findings"] = []
      ) =>
        validateContract(
          ScaRuleRescanResultSchema,
          {
            schema_version: 1,
            request_sha256: requestSha,
            status,
            reason,
            release_sha256: request.release_sha256,
            retained_baseline_sha256: request.retained_baseline_sha256,
            predecessor_investigation_sha256: request.predecessor_investigation_sha256,
            rescan_revision: request.rescan_revision,
            source_snapshot_sha256: request.source_snapshot_sha256,
            source_corpus_sha256: request.source_corpus_sha256,
            findings,
            reenter_investigation: status === "completed" && findings.length > 0,
            private_receipts_sha256: hashed(receipts),
          },
          "Separate source-only rescan result"
        );
      if (
        request.authority.decision !== "allow" ||
        !(await host.authorize("rescan", request, requestSha))
      )
        return outcome("denied", "separate_exact_rescan_authority_required");
      let stage: ReturnType<typeof privateStage> | undefined;
      try {
        control.signal?.throwIfAborted();
        const releaseBytes = readExactFile(
          request.release_path,
          request.limits.max_input_bytes,
          request.release_sha256
        );
        const release: ScaLearnedRuleRelease = validateContract(
          ScaLearnedRuleReleaseSchema,
          parseScaP10NativeJson(releaseBytes.toString("utf8")),
          "Promoted release"
        );
        if (
          path.basename(request.release_path) !== `${request.release_sha256}.json` ||
          release.predecessor_release_sha256 !== request.retained_baseline_sha256
        )
          throw new Error("release_lineage_drift");
        const record = validateContract(
          ScaRuleLearningRecordSchema,
          await host.readValidation(release.validation_sha256),
          "Retained full validation for rescan"
        );
        if (!(await replay(record)) || !releaseMatches(record, release))
          return outcome("denied", "full_admitted_validation_replay_required");
        const source = bindCorpus(request, corpus),
          files = [...source.files.values()];
        if (
          !files.length ||
          files.some(
            (f) =>
              !f.path.endsWith(
                release.language === "php"
                  ? ".php"
                  : release.language === "javascript"
                    ? ".js"
                    : ".ts"
              )
          )
        )
          throw new Error("rescan_profile_unsupported");
        const rule = decode(
          release.rule_content_base64,
          release.rule_sha256,
          request.limits.max_file_bytes
        );
        checkRule(rule, release.rule_id, release.language);
        const retainedRules = decode(
          release.retained_rule_content_base64,
          release.retained_rule_sha256,
          request.limits.max_file_bytes
        );
        stage = privateStage(host.workRoot);
        const config = path.join(stage.root, "candidate.json"),
          sourceRoot = path.join(stage.root, "source");
        mkdirSync(sourceRoot, { mode: 0o700 });
        writeNewFile(config, rule);
        writeNewFile(path.join(stage.root, "baseline.yml"), retainedRules);
        const targets: string[] = [];
        for (const file of files) {
          const target = path.join(sourceRoot, file.path);
          mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          writeNewFile(target, file.bytes);
          targets.push(target);
        }
        const receipt = await invoke(
          "rescan",
          null,
          requestSha,
          release.tool,
          request.limits,
          stage.root,
          config,
          targets,
          control
        );
        receipts.push(receipt);
        control.signal?.throwIfAborted();
        readCapturedFile(config, request.limits.max_file_bytes, release.rule_sha256);
        for (const file of files)
          readCapturedFile(
            path.join(sourceRoot, file.path),
            request.limits.max_file_bytes,
            file.content_sha256
          );
        readExactFile(request.release_path, request.limits.max_input_bytes, request.release_sha256);
        readCapturedFile(
          path.join(stage.root, "baseline.yml"),
          request.limits.max_file_bytes,
          release.retained_rule_sha256
        );
        const results = scan(
          receipt,
          release.tool.version,
          [release.rule_id, ...release.retained_rule_ids],
          targets
        );
        const findings = results.map((r) => {
          const relative = path.relative(sourceRoot, r.path).split(path.sep).join("/"),
            file = source.files.get(relative);
          if (
            !repositoryPath(relative) ||
            file === undefined ||
            r.end.line > file.text.split("\n").length
          )
            throw new Error("rescan_source_range_drift");
          return {
            rule_id: r.check_id,
            path: relative,
            start_line: r.start.line,
            end_line: r.end.line,
          };
        });
        return outcome(
          "completed",
          "new_investigation_revision_not_baseline_replacement_or_confirmation",
          findings
        );
      } catch {
        return outcome(
          "failed",
          control.signal?.aborted ? "cancelled" : "rescan_io_process_or_evidence_failure"
        );
      } finally {
        stage?.dispose();
      }
    },
  };
}
