import { readFileSync } from "node:fs";
import path from "node:path";

import { Type, type Static } from "typebox";

import { jcsCanonicalize, strictParseJson } from "../src/kb/approval-receipts.js";
import { sha256Hex, validateKbContract } from "../src/kb/contracts.js";

export const G8_SMOKE_MANIFEST_PATH = "apps/orchestration/smoke/g8-qwen3.8-cohort.jcs.json";
export const G8_SMOKE_RESULT_PATH =
  ".penny/plan-gates/hybrid-kb-ts-plan-2026-08-13/g8-qwen3.8-smoke-result.jcs.json";
export const G8_SMOKE_RESULT_SHA_PATH = `${G8_SMOKE_RESULT_PATH}.sha256`;

const CaseIdSchema = Type.Union([
  Type.Literal("sqlite-query"),
  Type.Literal("typebox-query"),
  Type.Literal("cross-query"),
]);

export const G8SmokeCohortManifestSchema = Type.Object(
  {
    bad_answer_ceiling: Type.Literal(0),
    case_ids: Type.Tuple([
      Type.Literal("sqlite-query"),
      Type.Literal("typebox-query"),
      Type.Literal("cross-query"),
    ]),
    cohort_id: Type.Literal("g8-qwen3.8-stable-final-carren"),
    fixture: Type.Object(
      {
        path: Type.Literal("apps/orchestration/tests/fixtures/kb-retrieval.json"),
        sha256: Type.Literal("c3d91aa0c414a0ebc68499e8a476b5d829e5434f2bf14595f9d35651bc02dc29"),
      },
      { additionalProperties: false }
    ),
    model: Type.Literal("ollama/qwen3.8:latest"),
    per_phase_timeout_ms: Type.Literal(300_000),
    post_start_exclusions: Type.Literal(0),
    post_start_retries: Type.Literal(0),
    privacy_incident_ceiling: Type.Literal(0),
    repetitions: Type.Literal(2),
    scheduled_pair_count: Type.Literal(6),
    schema_version: Type.Literal(1),
    thinking_level: Type.Literal("off"),
  },
  { additionalProperties: false }
);
export type G8SmokeCohortManifest = Static<typeof G8SmokeCohortManifestSchema>;

export interface G8SmokeScheduledPair {
  readonly pair_id: string;
  readonly case_id: G8SmokeCohortManifest["case_ids"][number];
  readonly repetition: 1 | 2;
}

export function parseG8SmokeCohortManifestJcs(raw: string | Uint8Array): G8SmokeCohortManifest {
  const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  const manifest = validateKbContract(
    G8SmokeCohortManifestSchema,
    strictParseJson(raw),
    "G8 qwen smoke cohort manifest"
  );
  if (text !== jcsCanonicalize(manifest)) {
    throw new Error("G8 qwen smoke cohort manifest is not exact JCS");
  }
  if (new Set(manifest.case_ids).size !== manifest.case_ids.length) {
    throw new Error("G8 qwen smoke cohort case IDs are not unique");
  }
  if (manifest.case_ids.length * manifest.repetitions !== manifest.scheduled_pair_count) {
    throw new Error("G8 qwen smoke cohort scheduled pair count drifted");
  }
  return manifest;
}

export function loadG8SmokeCohortManifest(repoRoot: string): {
  readonly manifest: G8SmokeCohortManifest;
  readonly bytes: string;
  readonly sha256: string;
} {
  const bytes = readFileSync(path.join(repoRoot, G8_SMOKE_MANIFEST_PATH), "utf8");
  const manifest = parseG8SmokeCohortManifestJcs(bytes);
  return { manifest, bytes, sha256: sha256Hex(bytes) };
}

export function g8SmokeScheduledPairs(
  manifest: G8SmokeCohortManifest
): readonly G8SmokeScheduledPair[] {
  const pairs = manifest.case_ids.flatMap((caseId) =>
    Array.from({ length: manifest.repetitions }, (_, index) => ({
      pair_id: `${caseId}#${index + 1}`,
      case_id: caseId,
      repetition: (index + 1) as 1 | 2,
    }))
  );
  if (pairs.length !== manifest.scheduled_pair_count) {
    throw new Error("G8 qwen smoke scheduler did not produce the exact frozen cohort");
  }
  return pairs;
}

export const G8_SMOKE_PROTOCOL_ERROR_CODES = [
  "schema_invalid",
  "handle_mismatch",
  "reader_ordering",
  "unknown_tool",
  "timeout",
] as const;

const ProtocolErrorCodeSchema = Type.Union([
  Type.Literal("schema_invalid"),
  Type.Literal("handle_mismatch"),
  Type.Literal("reader_ordering"),
  Type.Literal("unknown_tool"),
  Type.Literal("timeout"),
]);
const BadReasonSchema = Type.Union([
  Type.Literal("missing_result"),
  Type.Literal("not_complete_met"),
  Type.Literal("unsupported_citation"),
  Type.Literal("verification_unsupported"),
]);
const PhaseReceiptSchema = Type.Object(
  {
    agent: Type.Union([Type.Literal("synthia"), Type.Literal("vera")]),
    artifact_lifecycle: Type.String({ minLength: 1, maxLength: 32 }),
    observed: Type.Boolean(),
    parent_persistence_matches: Type.Boolean(),
    state_id: Type.Union([Type.Literal("query"), Type.Literal("verify")]),
    metrics: Type.Object(
      {
        cache_read_tokens: Type.Integer({ minimum: 0 }),
        cache_write_tokens: Type.Integer({ minimum: 0 }),
        input_tokens: Type.Integer({ minimum: 0 }),
        output_tokens: Type.Integer({ minimum: 0 }),
        protocol_error_codes: Type.Array(ProtocolErrorCodeSchema, { uniqueItems: true }),
        tool_errors: Type.Integer({ minimum: 0 }),
        tool_events: Type.Integer({ minimum: 0 }),
        total_tokens: Type.Integer({ minimum: 0 }),
        turn_events: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
const PairReceiptSchema = Type.Object(
  {
    case_id: CaseIdSchema,
    execution_count: Type.Literal(1),
    pair_id: Type.String({ pattern: "^(sqlite-query|typebox-query|cross-query)#[12]$" }),
    repetition: Type.Integer({ minimum: 1, maximum: 2 }),
    run_id: Type.String({
      pattern: "^run_kb_model_smoke_(sqlite_query|typebox_query|cross_query)_r[12]$",
    }),
    terminal: Type.Object(
      {
        action: Type.Union([
          Type.Literal("complete"),
          Type.Literal("incomplete"),
          Type.Literal("error"),
          Type.Literal("cancelled"),
          Type.Literal("missing"),
          Type.Literal("nonterminal"),
        ]),
        met: Type.Boolean(),
        observed: Type.Boolean(),
        status: Type.String({ minLength: 1, maxLength: 64 }),
      },
      { additionalProperties: false }
    ),
    phases: Type.Array(PhaseReceiptSchema, { maxItems: 2 }),
    metrics: Type.Object(
      {
        bad_answer: Type.Boolean(),
        bad_reasons: Type.Array(BadReasonSchema, { uniqueItems: true }),
        candidate_count: Type.Integer({ minimum: 0 }),
        child_session_files_created: Type.Integer({ minimum: 0 }),
        duration_ms: Type.Integer({ minimum: 0 }),
        event_count: Type.Integer({ minimum: 0 }),
        log_capture_count: Type.Integer({ minimum: 0 }),
        privacy_incidents: Type.Integer({ minimum: 0 }),
        protocol_issues: Type.Integer({ minimum: 0 }),
        receipt_count: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const G8SmokeResultReceiptSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    receipt_kind: Type.Literal("g8_qwen3_8_smoke_result"),
    cohort_id: Type.Literal("g8-qwen3.8-stable-final-carren"),
    manifest_matrix: Type.Tuple([
      Type.Object(
        {
          path: Type.Literal(G8_SMOKE_MANIFEST_PATH),
          sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
          scheduled_pair_count: Type.Literal(6),
        },
        { additionalProperties: false }
      ),
    ]),
    fixture_matrix: Type.Tuple([
      Type.Object(
        {
          case_ids: Type.Tuple([
            Type.Literal("sqlite-query"),
            Type.Literal("typebox-query"),
            Type.Literal("cross-query"),
          ]),
          fixture_id: Type.String({ minLength: 1, maxLength: 128 }),
          path: Type.Literal("apps/orchestration/tests/fixtures/kb-retrieval.json"),
          sha256: Type.Literal("c3d91aa0c414a0ebc68499e8a476b5d829e5434f2bf14595f9d35651bc02dc29"),
        },
        { additionalProperties: false }
      ),
    ]),
    model_matrix: Type.Tuple([
      Type.Object(
        {
          agent: Type.Literal("synthia"),
          locality: Type.Literal("local"),
          model: Type.Literal("qwen3.8:latest"),
          model_id: Type.Literal("ollama/qwen3.8:latest"),
          phase: Type.Literal("query"),
          provider: Type.Literal("ollama"),
          thinking_level: Type.Literal("off"),
        },
        { additionalProperties: false }
      ),
      Type.Object(
        {
          agent: Type.Literal("vera"),
          locality: Type.Literal("local"),
          model: Type.Literal("qwen3.8:latest"),
          model_id: Type.Literal("ollama/qwen3.8:latest"),
          phase: Type.Literal("verify"),
          provider: Type.Literal("ollama"),
          thinking_level: Type.Literal("off"),
        },
        { additionalProperties: false }
      ),
    ]),
    tool_matrix: Type.Tuple([
      Type.Object(
        {
          phase: Type.Literal("query"),
          tools: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
            minItems: 1,
            uniqueItems: true,
          }),
        },
        { additionalProperties: false }
      ),
      Type.Object(
        {
          phase: Type.Literal("verify"),
          tools: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
            minItems: 1,
            uniqueItems: true,
          }),
        },
        { additionalProperties: false }
      ),
    ]),
    schedule: Type.Object(
      {
        excluded_pairs: Type.Literal(0),
        repetitions: Type.Literal(2),
        retries: Type.Literal(0),
        scheduled_pairs: Type.Literal(6),
        started_pairs: Type.Integer({ minimum: 0, maximum: 6 }),
        terminal_pairs: Type.Integer({ minimum: 0, maximum: 6 }),
      },
      { additionalProperties: false }
    ),
    pairs: Type.Array(PairReceiptSchema, { maxItems: 6 }),
    totals: Type.Object(
      {
        bad_answers: Type.Integer({ minimum: 0, maximum: 6 }),
        good_pairs: Type.Integer({ minimum: 0, maximum: 6 }),
        privacy_incidents: Type.Integer({ minimum: 0 }),
        scheduled_pairs: Type.Literal(6),
        terminal_pairs: Type.Integer({ minimum: 0, maximum: 6 }),
      },
      { additionalProperties: false }
    ),
    outcome: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
    issue_codes: Type.Array(
      Type.Union([
        Type.Literal("missing_or_duplicate_pair"),
        Type.Literal("execution_count_invalid"),
        Type.Literal("nonterminal_pair"),
        Type.Literal("pair_contract_failure"),
        Type.Literal("bad_answer_ceiling_exceeded"),
        Type.Literal("privacy_incident_ceiling_exceeded"),
        Type.Literal("post_start_exclusion_detected"),
        Type.Literal("post_start_retry_detected"),
      ]),
      { uniqueItems: true }
    ),
    receipt_payload_sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  },
  { additionalProperties: false }
);
export type G8SmokeResultReceipt = Static<typeof G8SmokeResultReceiptSchema>;
export type G8SmokePairReceipt = Static<typeof PairReceiptSchema>;

export type G8SmokeIssueCode = G8SmokeResultReceipt["issue_codes"][number];
export type G8SmokeToolMatrix = readonly [
  { readonly phase: "query"; readonly tools: readonly string[] },
  { readonly phase: "verify"; readonly tools: readonly string[] },
];

function expectedRunId(pair: G8SmokeScheduledPair): string {
  return `run_kb_model_smoke_${pair.case_id.replace(/-/gu, "_")}_r${pair.repetition}`;
}

function terminalBadReasons(
  pair: G8SmokePairReceipt
): readonly G8SmokePairReceipt["metrics"]["bad_reasons"][number][] {
  if (!pair.terminal.observed || pair.terminal.action === "missing") return ["missing_result"];
  if (
    pair.terminal.action !== "complete" ||
    pair.terminal.status !== "complete" ||
    pair.terminal.met !== true
  ) {
    return ["not_complete_met"];
  }
  return [];
}

function hasExactSuccessfulPairContract(
  pair: G8SmokePairReceipt,
  expected: G8SmokeScheduledPair
): boolean {
  const expectedPhases = [
    { state_id: "query", agent: "synthia" },
    { state_id: "verify", agent: "vera" },
  ] as const;
  return (
    pair.pair_id === expected.pair_id &&
    pair.case_id === expected.case_id &&
    pair.repetition === expected.repetition &&
    pair.run_id === expectedRunId(expected) &&
    pair.execution_count === 1 &&
    pair.terminal.action === "complete" &&
    pair.terminal.status === "complete" &&
    pair.terminal.met === true &&
    pair.terminal.observed === true &&
    pair.phases.length === expectedPhases.length &&
    pair.phases.every((phase, index) => {
      const expectedPhase = expectedPhases[index];
      return (
        expectedPhase !== undefined &&
        phase.state_id === expectedPhase.state_id &&
        phase.agent === expectedPhase.agent &&
        phase.observed === true &&
        phase.artifact_lifecycle === "sealed" &&
        phase.parent_persistence_matches === true &&
        phase.metrics.protocol_error_codes.length === 0
      );
    }) &&
    pair.metrics.bad_answer === false &&
    pair.metrics.bad_reasons.length === 0 &&
    pair.metrics.child_session_files_created === 0 &&
    pair.metrics.privacy_incidents === 0 &&
    pair.metrics.protocol_issues === 0 &&
    pair.metrics.receipt_count === 2
  );
}

export function g8SmokeCohortIssueCodes(input: {
  readonly manifest: G8SmokeCohortManifest;
  readonly pairs: readonly G8SmokePairReceipt[];
  readonly excludedPairs: number;
  readonly retries: number;
}): readonly G8SmokeIssueCode[] {
  const issues = new Set<G8SmokeIssueCode>();
  const expected = g8SmokeScheduledPairs(input.manifest).map((pair) => pair.pair_id);
  const actual = input.pairs.map((pair) => pair.pair_id);
  if (
    jcsCanonicalize(actual) !== jcsCanonicalize(expected) ||
    new Set(actual).size !== actual.length
  ) {
    issues.add("missing_or_duplicate_pair");
  }
  if (input.pairs.some((pair) => pair.execution_count !== 1)) {
    issues.add("execution_count_invalid");
  }
  if (input.pairs.some((pair) => !pair.terminal.observed)) issues.add("nonterminal_pair");
  const scheduled = g8SmokeScheduledPairs(input.manifest);
  if (
    input.pairs.some((pair, index) => {
      const expectedPair = scheduled[index];
      const derivedBadReasons = terminalBadReasons(pair);
      return (
        expectedPair === undefined ||
        !hasExactSuccessfulPairContract(pair, expectedPair) ||
        pair.metrics.bad_answer !== derivedBadReasons.length > 0 ||
        jcsCanonicalize(pair.metrics.bad_reasons) !== jcsCanonicalize(derivedBadReasons)
      );
    })
  ) {
    issues.add("pair_contract_failure");
  }
  if (
    input.pairs.filter((pair) => pair.metrics.bad_answer).length > input.manifest.bad_answer_ceiling
  ) {
    issues.add("bad_answer_ceiling_exceeded");
  }
  if (
    input.pairs.reduce((sum, pair) => sum + pair.metrics.privacy_incidents, 0) >
    input.manifest.privacy_incident_ceiling
  ) {
    issues.add("privacy_incident_ceiling_exceeded");
  }
  if (input.excludedPairs !== input.manifest.post_start_exclusions) {
    issues.add("post_start_exclusion_detected");
  }
  if (input.retries !== input.manifest.post_start_retries) {
    issues.add("post_start_retry_detected");
  }
  return [...issues];
}

export function validateG8SmokeResultReceipt(
  value: unknown,
  manifest: G8SmokeCohortManifest,
  toolMatrix: G8SmokeToolMatrix
): G8SmokeResultReceipt {
  const receipt = validateKbContract(
    G8SmokeResultReceiptSchema,
    value,
    "G8 qwen smoke result receipt"
  );
  const { receipt_payload_sha256: payloadSha256, ...payload } = receipt;
  if (sha256Hex(jcsCanonicalize(payload)) !== payloadSha256) {
    throw new Error("G8 qwen smoke result payload digest drifted");
  }
  const manifestSha256 = sha256Hex(jcsCanonicalize(manifest));
  if (
    receipt.manifest_matrix[0].sha256 !== manifestSha256 ||
    receipt.manifest_matrix[0].scheduled_pair_count !== manifest.scheduled_pair_count
  ) {
    throw new Error("G8 qwen smoke result manifest binding drifted");
  }
  if (jcsCanonicalize(receipt.tool_matrix) !== jcsCanonicalize(toolMatrix)) {
    throw new Error("G8 qwen smoke result tool matrix drifted");
  }
  const expectedPairs = g8SmokeScheduledPairs(manifest);
  if (
    receipt.pairs.length !== manifest.scheduled_pair_count ||
    receipt.pairs.some((pair, index) => {
      const expected = expectedPairs[index];
      return expected === undefined || !hasExactSuccessfulPairContract(pair, expected);
    })
  ) {
    throw new Error("G8 qwen smoke result pair contract drifted");
  }
  for (const pair of receipt.pairs) {
    const derivedBadReasons = terminalBadReasons(pair);
    if (
      pair.metrics.bad_answer !== derivedBadReasons.length > 0 ||
      jcsCanonicalize(pair.metrics.bad_reasons) !== jcsCanonicalize(derivedBadReasons)
    ) {
      throw new Error("G8 qwen smoke result bad-answer evidence drifted");
    }
  }
  const issues = g8SmokeCohortIssueCodes({
    manifest,
    pairs: receipt.pairs,
    excludedPairs: receipt.schedule.excluded_pairs,
    retries: receipt.schedule.retries,
  });
  if (jcsCanonicalize(receipt.issue_codes) !== jcsCanonicalize(issues)) {
    throw new Error("G8 qwen smoke result issue projection drifted");
  }
  if (
    issues.length !== 0 ||
    receipt.issue_codes.length !== 0 ||
    receipt.outcome !== "pass" ||
    receipt.schedule.excluded_pairs !== 0 ||
    receipt.schedule.retries !== 0 ||
    receipt.schedule.repetitions !== manifest.repetitions ||
    receipt.schedule.scheduled_pairs !== manifest.scheduled_pair_count ||
    receipt.schedule.started_pairs !== manifest.scheduled_pair_count ||
    receipt.schedule.terminal_pairs !== manifest.scheduled_pair_count
  ) {
    throw new Error("G8 qwen smoke result successful outcome contract drifted");
  }
  const terminalPairs = receipt.pairs.filter((pair) => pair.terminal.observed).length;
  const badAnswers = receipt.pairs.filter((pair) => pair.metrics.bad_answer).length;
  const privacyIncidents = receipt.pairs.reduce(
    (sum, pair) => sum + pair.metrics.privacy_incidents,
    0
  );
  if (
    receipt.schedule.started_pairs !== receipt.pairs.length ||
    receipt.schedule.terminal_pairs !== terminalPairs ||
    receipt.totals.terminal_pairs !== terminalPairs ||
    receipt.totals.bad_answers !== badAnswers ||
    receipt.totals.good_pairs !== receipt.pairs.length - badAnswers ||
    receipt.totals.privacy_incidents !== privacyIncidents ||
    receipt.totals.scheduled_pairs !== manifest.scheduled_pair_count ||
    badAnswers !== 0 ||
    privacyIncidents !== 0
  ) {
    throw new Error("G8 qwen smoke result totals drifted");
  }
  return receipt;
}

export function parseG8SmokeResultReceiptJcs(
  raw: string | Uint8Array,
  manifest: G8SmokeCohortManifest,
  toolMatrix: G8SmokeToolMatrix
): G8SmokeResultReceipt {
  const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  const receipt = validateG8SmokeResultReceipt(strictParseJson(raw), manifest, toolMatrix);
  if (text !== jcsCanonicalize(receipt)) {
    throw new Error("G8 qwen smoke result receipt is not exact JCS");
  }
  return receipt;
}

export function loadG8SmokeResultReceipt(
  repoRoot: string,
  toolMatrix: G8SmokeToolMatrix
): {
  readonly receipt: G8SmokeResultReceipt;
  readonly bytes: string;
  readonly sha256: string;
  readonly sidecar: string;
} {
  const { manifest } = loadG8SmokeCohortManifest(repoRoot);
  const resultPath = path.join(repoRoot, G8_SMOKE_RESULT_PATH);
  const bytes = readFileSync(resultPath, "utf8");
  const sha256 = sha256Hex(bytes);
  const sidecar = readFileSync(path.join(repoRoot, G8_SMOKE_RESULT_SHA_PATH), "utf8");
  const expectedSidecar = `${sha256}  ${path.basename(resultPath)}\n`;
  if (sidecar !== expectedSidecar) {
    throw new Error("G8 qwen smoke result SHA sidecar drifted");
  }
  return {
    receipt: parseG8SmokeResultReceiptJcs(bytes, manifest, toolMatrix),
    bytes,
    sha256,
    sidecar,
  };
}
