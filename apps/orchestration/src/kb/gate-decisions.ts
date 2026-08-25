import { spawnSync } from "node:child_process";
import path from "node:path";

import { strictParseJson } from "./approval-receipts.js";
import {
  GateDecisionReceiptV1Schema,
  KbRetrievalFixtureV1Schema,
  ObservationCohortManifestV1Schema,
  ObservationWindowDecisionV1Schema,
  PackageSurfaceDecisionV1Schema,
  ResearchObservationProjectionV1Schema,
  RetrievalBaselineDecisionV1Schema,
  canonicalJson,
  sha256Hex,
  validateKbContract,
  type GateDecisionReceiptV1,
  type KbRetrievalFixtureV1,
  type ObservationWindowDecisionV1,
  type PackageSurfaceDecisionV1,
  type ResearchObservationProjectionV1,
  type RetrievalBaselineDecisionV1,
  type Sha256Hex,
} from "./contracts.js";

export class GateDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateDecisionError";
  }
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function exactCanonical(value: unknown): string {
  return canonicalJson(value);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reviewDecision(receipt: GateDecisionReceiptV1): void {
  if (receipt.approved_by_subject_id === receipt.reviewed_by_subject_id) {
    throw new GateDecisionError("gate decision approver and reviewer must differ");
  }
  const { review_sha256: reviewSha256, ...decision } = receipt;
  if (sha256Hex(exactCanonical(decision)) !== reviewSha256) {
    throw new GateDecisionError("gate decision review_sha256 does not bind the exact decision");
  }
}

/** Duplicate-safe strict JSON plus byte-exact RFC 8785/JCS receipt admission. */
export function parseGateDecisionReceiptJcs(raw: string | Uint8Array): GateDecisionReceiptV1 {
  const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  const parsed = strictParseJson(text);
  const receipt = validateKbContract(GateDecisionReceiptV1Schema, parsed, "gate decision receipt");
  if (text !== exactCanonical(receipt)) {
    throw new GateDecisionError("gate decision receipt bytes are not exact JCS");
  }
  validateGateDecisionReceipt(receipt);
  return receipt;
}

export function validateGateDecisionReceipt(value: unknown): GateDecisionReceiptV1 {
  const receipt = validateKbContract(GateDecisionReceiptV1Schema, value, "gate decision receipt");
  reviewDecision(receipt);
  if (receipt.decision_kind === "package_surface") validatePackageSurfaceDecision(receipt);
  if (receipt.decision_kind === "retrieval_baseline") validateRetrievalBaselineDecision(receipt);
  if (receipt.decision_kind === "research_observation") validateObservationWindowDecision(receipt);
  return receipt;
}

export function validatePackageSurfaceDecision(value: unknown): PackageSurfaceDecisionV1 {
  const receipt = validateKbContract(
    PackageSurfaceDecisionV1Schema,
    value,
    "package-surface decision"
  );
  reviewDecision(receipt);
  const files = [...receipt.expected_pack_files];
  if (new Set(files).size !== files.length) {
    throw new GateDecisionError("expected_pack_files must be unique");
  }
  if (files.some((file, index) => index > 0 && utf8Compare(files[index - 1] ?? "", file) >= 0)) {
    throw new GateDecisionError("expected_pack_files must be strictly UTF-8 bytewise sorted");
  }
  for (const file of files) {
    const segments = file.split("/");
    if (
      path.posix.isAbsolute(file) ||
      path.win32.isAbsolute(file) ||
      file.includes("\\") ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new GateDecisionError(`expected pack file is not a safe relative path: ${file}`);
    }
  }
  return receipt;
}

export interface PackageSurfaceSnapshotV1 {
  readonly name: string;
  readonly version: string;
  readonly private: true;
  readonly exports: Readonly<Record<string, string>>;
  readonly bin: Readonly<Record<string, string>>;
  readonly scripts: Readonly<Record<string, string>>;
}

export function parseBunPackDryRun(output: string): readonly string[] {
  const files = output
    .split(/\r?\n/u)
    .map((line) => line.match(/^packed\s+\S+\s+(.+)$/u)?.[1]?.trim())
    .filter((file): file is string => file !== undefined && file.length > 0);
  if (files.length === 0) {
    throw new GateDecisionError("bun pm pack output was unparseable or contained zero files");
  }
  if (new Set(files).size !== files.length) {
    throw new GateDecisionError("bun pm pack output contains duplicate file entries");
  }
  return [...files].sort(utf8Compare);
}

export interface BunPackDryRunExecutionV1 {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export function bunPackFilesFromExecution(result: BunPackDryRunExecutionV1): readonly string[] {
  if (result.error !== undefined || result.status !== 0) {
    const output = String(result.stderr || result.stdout).trim();
    const reason = result.error?.message ?? (output || `status ${result.status}`);
    throw new GateDecisionError(`bun pm pack --cwd apps/orchestration --dry-run failed: ${reason}`);
  }
  return parseBunPackDryRun(`${result.stdout}${result.stderr}`);
}

export function runBunPackDryRun(repoRoot: string): readonly string[] {
  const result = spawnSync("bun", ["pm", "pack", "--cwd", "apps/orchestration", "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
  return bunPackFilesFromExecution({
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    ...(result.error === undefined ? {} : { error: result.error }),
  });
}

export function assertPackageSurfaceDecision(input: {
  readonly decision: PackageSurfaceDecisionV1;
  readonly packageJson: unknown;
  readonly packFiles: readonly string[];
}): void {
  const decision = validatePackageSurfaceDecision(input.decision);
  if (!isUnknownRecord(input.packageJson)) {
    throw new GateDecisionError("package.json must be an object");
  }
  const pkg = input.packageJson;
  const snapshot = validateKbContract(
    PackageSurfaceDecisionV1Schema,
    {
      ...decision,
      package_name: pkg["name"],
      package_version: pkg["version"],
      package_private: pkg["private"],
      exports: pkg["exports"],
      bin: pkg["bin"],
      scripts: pkg["scripts"],
      expected_pack_files: [...input.packFiles].sort(utf8Compare),
    },
    "live package-surface projection"
  );
  const expected = {
    package_name: decision.package_name,
    package_version: decision.package_version,
    package_private: decision.package_private,
    exports: decision.exports,
    bin: decision.bin,
    scripts: decision.scripts,
    expected_pack_files: decision.expected_pack_files,
  };
  const actual = {
    package_name: snapshot.package_name,
    package_version: snapshot.package_version,
    package_private: snapshot.package_private,
    exports: snapshot.exports,
    bin: snapshot.bin,
    scripts: snapshot.scripts,
    expected_pack_files: snapshot.expected_pack_files,
  };
  if (exactCanonical(actual) !== exactCanonical(expected)) {
    throw new GateDecisionError(
      "live package surface does not exactly match the reviewed decision"
    );
  }
}

function endpointKey(endpoint: { page_id: string; revision_id: string; claim_id: string }): string {
  return `${endpoint.page_id}\u0000${endpoint.revision_id}\u0000${endpoint.claim_id}`;
}

function contradictionKey(pair: {
  left: { page_id: string; revision_id: string; claim_id: string };
  right: { page_id: string; revision_id: string; claim_id: string };
}): string {
  return [endpointKey(pair.left), endpointKey(pair.right)].sort(utf8Compare).join("\u0001");
}

/** Duplicate-safe fixture parse. Raw fixture bytes remain the reviewed digest input. */
export function parseRetrievalFixture(raw: string | Uint8Array): KbRetrievalFixtureV1 {
  const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  return validateRetrievalFixture(
    validateKbContract(KbRetrievalFixtureV1Schema, strictParseJson(text), "retrieval fixture")
  );
}

export function validateRetrievalFixture(value: unknown): KbRetrievalFixtureV1 {
  const fixture = validateKbContract(KbRetrievalFixtureV1Schema, value, "retrieval fixture");
  const pages = new Map<string, (typeof fixture.corpus)[number]>();
  const claims = new Map<string, (typeof fixture.corpus)[number]>();
  const sourceIds = new Set<string>();
  for (const page of fixture.corpus) {
    const pageKey = `${page.frontmatter.page_id}\u0000${page.frontmatter.revision_id}`;
    if (pages.has(pageKey))
      throw new GateDecisionError("retrieval fixture has duplicate corpus revisions");
    if (
      page.claims.page_id !== page.frontmatter.page_id ||
      page.claims.revision_id !== page.frontmatter.revision_id
    ) {
      throw new GateDecisionError(
        "retrieval fixture claims sidecar does not bind its page revision"
      );
    }
    pages.set(pageKey, page);
    for (const claim of page.claims.claims) {
      if (claims.has(claim.claim_id)) {
        throw new GateDecisionError("retrieval fixture claim IDs must be globally unique");
      }
      claims.set(claim.claim_id, page);
      for (const evidence of claim.evidence) sourceIds.add(evidence.source_id);
    }
  }

  const caseIds = new Set<string>();
  const contradictionLabels = new Set<string>();
  let contradictionCount = 0;
  for (const testCase of fixture.cases) {
    if (caseIds.has(testCase.case_id))
      throw new GateDecisionError("retrieval case IDs must be unique");
    caseIds.add(testCase.case_id);
    const relevantKeys = testCase.expected_relevant.map(
      (item) => `${item.page_id}\u0000${item.revision_id}`
    );
    if (new Set(relevantKeys).size !== relevantKeys.length) {
      throw new GateDecisionError("expected_relevant entries must be unique");
    }
    for (const relevant of relevantKeys) {
      if (!pages.has(relevant))
        throw new GateDecisionError("expected_relevant points outside the corpus");
    }
    const citationKeys = testCase.supported_citations.map(exactCanonical);
    if (new Set(citationKeys).size !== citationKeys.length) {
      throw new GateDecisionError("supported_citations entries must be unique");
    }
    for (const citation of testCase.supported_citations) {
      if (
        citation.kind === "source"
          ? !sourceIds.has(citation.source_id)
          : citation.kind === "page"
            ? !pages.has(`${citation.page_id}\u0000${citation.revision_id}`)
            : claims.get(citation.claim_id) !==
              pages.get(`${citation.page_id}\u0000${citation.revision_id}`)
      ) {
        throw new GateDecisionError("supported citation does not resolve inside the fixture");
      }
    }
    for (const pair of testCase.expected_contradictions) {
      contradictionCount += 1;
      const label = contradictionKey(pair);
      if (contradictionLabels.has(label)) {
        throw new GateDecisionError("retrieval contradiction labels must be unique");
      }
      contradictionLabels.add(label);
      for (const endpoint of [pair.left, pair.right]) {
        const page = pages.get(`${endpoint.page_id}\u0000${endpoint.revision_id}`);
        if (page === undefined || claims.get(endpoint.claim_id) !== page) {
          throw new GateDecisionError("retrieval contradiction endpoint does not resolve");
        }
      }
      const leftClaim = pair.left.claim_id;
      const rightClaim = pair.right.claim_id;
      const left = claims
        .get(leftClaim)
        ?.claims.claims.find((claim) => claim.claim_id === leftClaim);
      const right = claims
        .get(rightClaim)
        ?.claims.claims.find((claim) => claim.claim_id === rightClaim);
      if (
        left?.contradicts_claim_ids.includes(rightClaim) !== true ||
        right?.contradicts_claim_ids.includes(leftClaim) !== true
      ) {
        throw new GateDecisionError("retrieval contradiction label is not bidirectionally linked");
      }
    }
  }
  if (contradictionCount === 0) {
    throw new GateDecisionError("retrieval fixture requires at least one contradiction label");
  }
  return fixture;
}

export function validateRetrievalBaselineDecision(value: unknown): RetrievalBaselineDecisionV1 {
  const receipt = validateKbContract(
    RetrievalBaselineDecisionV1Schema,
    value,
    "retrieval-baseline decision"
  );
  reviewDecision(receipt);
  return receipt;
}

export function assertRetrievalDecisionFixture(input: {
  readonly decision: RetrievalBaselineDecisionV1;
  readonly fixtureBytes: string | Uint8Array;
}): KbRetrievalFixtureV1 {
  const decision = validateRetrievalBaselineDecision(input.decision);
  const bytes =
    typeof input.fixtureBytes === "string" ? input.fixtureBytes : Buffer.from(input.fixtureBytes);
  const fixture = parseRetrievalFixture(bytes);
  if (
    sha256Hex(typeof bytes === "string" ? bytes : bytes.toString("utf8")) !==
    decision.fixture_sha256
  ) {
    throw new GateDecisionError("retrieval fixture digest does not match the reviewed decision");
  }
  if (fixture.cases.length !== decision.case_count) {
    throw new GateDecisionError(
      "retrieval fixture case count does not match the reviewed decision"
    );
  }
  return fixture;
}

export function validateObservationWindowDecision(value: unknown): ObservationWindowDecisionV1 {
  const receipt = validateKbContract(
    ObservationWindowDecisionV1Schema,
    value,
    "research-observation decision"
  );
  reviewDecision(receipt);
  const cohort = validateKbContract(
    ObservationCohortManifestV1Schema,
    receipt.cohort,
    "research-observation cohort"
  );
  if (sha256Hex(exactCanonical(cohort)) !== receipt.cohort_sha256) {
    throw new GateDecisionError("observation cohort_sha256 does not bind the exact cohort");
  }
  const caseIds = cohort.cases.map((item) => item.case_id);
  if (new Set(caseIds).size !== caseIds.length) {
    throw new GateDecisionError("observation cohort case IDs must be unique");
  }
  const scheduled = cohort.cases.reduce((total, item) => total + item.repetitions, 0);
  if (
    scheduled !== cohort.scheduled_pair_count ||
    scheduled !== receipt.minimum_paired_terminal_runs
  ) {
    throw new GateDecisionError(
      "observation scheduled_pair_count must equal repetitions and minimum_paired_terminal_runs"
    );
  }
  return receipt;
}

export interface ObservationRunEvidenceV1 {
  readonly projection: ResearchObservationProjectionV1;
  readonly latency_ms: number;
  readonly provider_reported_cost_usd: number;
  readonly privacy_incidents: number;
  readonly recovery_failures: number;
}

export interface ObservationPairEvidenceV1 {
  readonly case_id: string;
  readonly repetition: number;
  readonly baseline: ObservationRunEvidenceV1;
  readonly candidate: ObservationRunEvidenceV1;
}

export interface ObservationOracleResultV1 {
  readonly pair_count: number;
  readonly duration_hours: number;
  readonly unexplained_parity_mismatches: number;
  readonly privacy_incidents: number;
  readonly recovery_failures: number;
  readonly p95_latency_ratio: number;
  readonly mean_cost_ratio: number;
}

function evidenceNumber(value: number, label: string, allowZero: boolean): void {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new GateDecisionError(
      `${label} must be a finite ${allowZero ? "non-negative" : "positive"} number`
    );
  }
}

function nearestRankP95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.ceil(0.95 * sorted.length) - 1];
  if (value === undefined) throw new GateDecisionError("observation latency population is empty");
  return value;
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function evaluateObservationDecision(input: {
  readonly decision: ObservationWindowDecisionV1;
  readonly researchFixtureBytes: string | Uint8Array;
  readonly normalizationRulesBytes: string | Uint8Array;
  readonly runtimeConfigBytes: string | Uint8Array;
  readonly modelSetBytes: string | Uint8Array;
  readonly firstDispatchAt: string;
  readonly lastTerminalAt: string;
  readonly pairs: readonly ObservationPairEvidenceV1[];
}): ObservationOracleResultV1 {
  const decision = validateObservationWindowDecision(input.decision);
  const cohort = decision.cohort;
  const digest = (value: string | Uint8Array): Sha256Hex =>
    sha256Hex(typeof value === "string" ? value : Buffer.from(value).toString("utf8"));
  if (
    digest(input.researchFixtureBytes) !== cohort.research_fixture_sha256 ||
    digest(input.normalizationRulesBytes) !== cohort.normalization_rules_sha256 ||
    digest(input.runtimeConfigBytes) !== cohort.runtime_config_sha256 ||
    digest(input.modelSetBytes) !== cohort.model_set_sha256
  ) {
    throw new GateDecisionError(
      "observation evidence bytes do not match the frozen cohort digests"
    );
  }

  const expected = new Set<string>();
  for (const testCase of cohort.cases) {
    for (let repetition = 1; repetition <= testCase.repetitions; repetition += 1) {
      expected.add(`${testCase.case_id}\u0000${repetition}`);
    }
  }
  const seen = new Set<string>();
  const baselineLatencies: number[] = [];
  const candidateLatencies: number[] = [];
  const baselineCosts: number[] = [];
  const candidateCosts: number[] = [];
  let mismatches = 0;
  let privacyIncidents = 0;
  let recoveryFailures = 0;
  for (const pair of input.pairs) {
    const key = `${pair.case_id}\u0000${pair.repetition}`;
    if (!expected.has(key) || seen.has(key)) {
      throw new GateDecisionError(
        "observation pairs must contain every scheduled identity exactly once"
      );
    }
    seen.add(key);
    for (const [engine, run] of [
      ["baseline", pair.baseline],
      ["candidate", pair.candidate],
    ] as const) {
      const projection = validateKbContract(
        ResearchObservationProjectionV1Schema,
        run.projection,
        `${engine} observation projection`
      );
      if (projection.case_id !== pair.case_id) {
        throw new GateDecisionError(
          "observation projection case_id does not bind its scheduled pair"
        );
      }
      evidenceNumber(run.latency_ms, `${engine} latency_ms`, false);
      evidenceNumber(run.provider_reported_cost_usd, `${engine} provider cost`, true);
      if (
        !Number.isSafeInteger(run.privacy_incidents) ||
        run.privacy_incidents < 0 ||
        !Number.isSafeInteger(run.recovery_failures) ||
        run.recovery_failures < 0
      ) {
        throw new GateDecisionError(
          "observation incident/failure counts must be non-negative safe integers"
        );
      }
    }
    baselineLatencies.push(pair.baseline.latency_ms);
    candidateLatencies.push(pair.candidate.latency_ms);
    baselineCosts.push(pair.baseline.provider_reported_cost_usd);
    candidateCosts.push(pair.candidate.provider_reported_cost_usd);
    privacyIncidents += pair.baseline.privacy_incidents + pair.candidate.privacy_incidents;
    recoveryFailures += pair.baseline.recovery_failures + pair.candidate.recovery_failures;
    if (exactCanonical(pair.baseline.projection) !== exactCanonical(pair.candidate.projection)) {
      mismatches += 1;
    }
  }
  if (seen.size !== expected.size || input.pairs.length !== cohort.scheduled_pair_count) {
    throw new GateDecisionError("observation evidence is missing one or more scheduled pairs");
  }

  const first = Date.parse(input.firstDispatchAt);
  const last = Date.parse(input.lastTerminalAt);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) {
    throw new GateDecisionError("observation duration timestamps are invalid");
  }
  const durationHours = (last - first) / 3_600_000;
  const baselineP95 = nearestRankP95(baselineLatencies);
  const candidateP95 = nearestRankP95(candidateLatencies);
  const baselineMeanCost = mean(baselineCosts);
  const candidateMeanCost = mean(candidateCosts);
  const result: ObservationOracleResultV1 = {
    pair_count: input.pairs.length,
    duration_hours: durationHours,
    unexplained_parity_mismatches: mismatches,
    privacy_incidents: privacyIncidents,
    recovery_failures: recoveryFailures,
    p95_latency_ratio: candidateP95 / baselineP95,
    mean_cost_ratio:
      baselineMeanCost === 0
        ? candidateMeanCost === 0
          ? 1
          : Number.POSITIVE_INFINITY
        : candidateMeanCost / baselineMeanCost,
  };
  return result;
}

export function assertObservationDecision(
  input: Parameters<typeof evaluateObservationDecision>[0]
): ObservationOracleResultV1 {
  const decision = validateObservationWindowDecision(input.decision);
  const result = evaluateObservationDecision(input);
  if (
    result.duration_hours < decision.minimum_duration_hours ||
    result.pair_count < decision.minimum_paired_terminal_runs ||
    result.unexplained_parity_mismatches > decision.maximum_unexplained_parity_mismatches ||
    result.privacy_incidents > decision.maximum_privacy_incidents ||
    result.recovery_failures > decision.maximum_recovery_failures ||
    result.p95_latency_ratio > decision.maximum_p95_latency_ratio ||
    result.mean_cost_ratio > decision.maximum_mean_cost_ratio
  ) {
    throw new GateDecisionError(
      "research-observation evidence does not satisfy the frozen decision"
    );
  }
  return result;
}
