import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { type ArtifactRef } from "../contracts.js";
import {
  validateScaP11RepairRecordV1,
  validateScaP11ReportJsonV1,
  validateScaP11ReportSarifV1,
  validateScaP11ScoringRecordsV1,
  validateScaP11SemanticReviewV1,
} from "./p11-contracts.js";
import { renderScaP11MarkdownV1, scaP11FindingId } from "./p11-render.js";
import { resolveScaP11CvssScorerAuthority } from "./p11-scoring.js";
import { validateScaP11Deterministic } from "./p11-validation.js";
import type { ScaP12AdmissionResultV1 } from "./p12-admission.js";
import type { ScaP12PhaseGateDerivedExclusionsV1 } from "./p12-release.js";
import {
  SCA_P12_DIMENSIONS,
  SCA_P12_REPLAY_EVIDENCE_SCHEMA,
  SCA_P12_REQUIRED_MODEL,
  SCA_P12_VERIFIER_VERDICTS_SCHEMA,
  validateScaP12ReplayEvidenceV1,
  validateScaP12VerificationScopeV1,
  validateScaP12VerifierAuthorityV1,
  validateScaP12VerifierVerdictsV1,
  withP12Digest,
  type ScaP12DimensionV1,
  type ScaP12OpenItemDispositionV1,
  type ScaP12ReleaseAuthorityV1,
  type ScaP12ReplayEvidenceV1,
  type ScaP12VerdictV1,
  type ScaP12VerificationScopeV1,
  type ScaP12VerifierAuthorityV1,
  type ScaP12VerifierVerdictsV1,
} from "./p12-contracts.js";

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}
function uniqueSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
function exactReadable(store: ArtifactHostStore, ref: ArtifactRef): boolean {
  const stored = store.refById(ref.artifact_id);
  if (stored === undefined || !same(stored, ref)) return false;
  const bytes = store.readById(ref.artifact_id);
  return bytes.byteLength === ref.byte_length && sha256(bytes) === ref.content_digest;
}
function readText(store: ArtifactHostStore, ref: ArtifactRef): string {
  const bytes = store.readById(ref.artifact_id);
  return bytes.toString("utf8");
}

// --- Independence ----------------------------------------------------------------------------

/**
 * P11 cognitive artifact kinds whose producers/operation identities the host must also exclude: the
 * semantic review record and raw reviewer output, the bounded repair patch, and the repair record.
 */
const SCA_P12_P11_COGNITIVE_KINDS = new Set([
  "sca-p11-semantic-review",
  "sca-p11-repair-patch",
  "sca-p11-repair-record",
]);

export interface ScaP12IndependenceExclusionsV1 {
  readonly identity_ids: readonly string[];
  readonly lineage_ids: readonly string[];
  /** False when the host could not derive exclusions from verified records (fail closed). */
  readonly available: boolean;
}

/**
 * Derive the P12 verifier exclusion set from the exact P11 record set (P12-R07). It never reads the
 * verifier authority's own `excluded_*` payload: the identity/lineage surface comes from the verified
 * AC-P01..AC-P11 phase-gate qualification/reviewer records, every P11 report/host producer, and — the
 * residual this closes — the exact P11 semantic reviewer/bounded repairer identity and execution
 * lineage recorded in the semantic review and repair records. It additionally traverses the P11
 * checksum manifest so a captured reviewer/repairer worker output producer (for example `agent:vera`)
 * is excluded even when a record's own metadata omitted it. `available` is false unless the host fully
 * re-verified the phase-gate index, so an underivable set fails closed rather than granting separation.
 */
export function deriveScaP12IndependenceExclusionsV1(input: {
  readonly store: ArtifactHostStore;
  readonly admission: ScaP12AdmissionResultV1;
  readonly phase_gate_exclusions: ScaP12PhaseGateDerivedExclusionsV1 | null;
  readonly phase_gate_complete: boolean;
}): ScaP12IndependenceExclusionsV1 {
  const { store, admission } = input;
  const identities = new Set<string>();
  const lineages = new Set<string>();
  if (input.phase_gate_exclusions !== null) {
    for (const id of input.phase_gate_exclusions.identity_ids) identities.add(id);
    for (const id of input.phase_gate_exclusions.lineage_ids) lineages.add(id);
  }
  for (const ref of admission.evidence_refs) identities.add(ref.producer);
  if (admission.report !== null) {
    for (const ref of [
      admission.report.json_ref,
      admission.report.markdown_ref,
      admission.report.sarif_ref,
      admission.report.reconciliation_ref,
      admission.report.validation_records_ref,
      admission.report.checksum_manifest_ref,
      admission.report.obligation_ledger_ref,
    ]) {
      identities.add(ref.producer);
    }
  }
  const validation = admission.validation;
  if (validation !== null && validation.semantic_review_ref !== null) {
    const ref = validation.semantic_review_ref;
    identities.add(ref.producer);
    lineages.add(ref.operation_id);
    if (exactReadable(store, ref)) {
      try {
        const review = validateScaP11SemanticReviewV1(JSON.parse(readText(store, ref)));
        identities.add(review.reviewer_identity_id);
        lineages.add(review.reviewer_lineage_id);
        lineages.add(review.call_id);
      } catch {
        // An unreadable/invalid review record is still excluded by its producer/operation identity.
      }
    }
  }
  if (validation !== null) {
    for (const ref of validation.repair_records) {
      identities.add(ref.producer);
      lineages.add(ref.operation_id);
      if (exactReadable(store, ref)) {
        try {
          const record = validateScaP11RepairRecordV1(JSON.parse(readText(store, ref)));
          identities.add(record.repairer_identity_id);
          lineages.add(record.repairer_lineage_id);
        } catch {
          // An unreadable/invalid repair record is still excluded by its producer/operation identity.
        }
      }
    }
  }
  if (admission.checksum !== null) {
    for (const entry of admission.checksum.artifacts) {
      if (!SCA_P12_P11_COGNITIVE_KINDS.has(entry.kind)) continue;
      const stored = store.refById(entry.artifact_id);
      if (stored === undefined) continue;
      identities.add(stored.producer);
      lineages.add(stored.operation_id);
    }
  }
  return {
    identity_ids: [...identities].sort(),
    lineage_ids: [...lineages].sort(),
    available: input.phase_gate_exclusions !== null && input.phase_gate_complete,
  };
}

export interface ScaP12IndependenceResultV1 {
  readonly verifier_independent: boolean;
  readonly verifier_subset_authority: boolean;
  readonly verifier_authority_current: boolean;
  readonly release_authority_valid: boolean;
  readonly release_authority_distinct: boolean;
  readonly blocker_codes: readonly string[];
}

/**
 * Independent release-verification identity/lineage/authority separation (P12-R07/R08). The exclusion
 * set is supplied by the host from *verified* records — the re-verified AC-P01..AC-P11 gate
 * qualification/reviewer identities plus the exact P11 report/reviewer/host producer lineages — never
 * from the verifier authority's own payload. The verifier must additionally hold the strict-subset
 * no-authority surface, bind the pinned model, and resolve to a current host authority. A verifier
 * whose identity or lineage intersects the derived exclusion set is rejected; when the host cannot
 * derive the exclusion set from verified records, independence is unverifiable and fails closed.
 */
export function checkScaP12Independence(input: {
  readonly verifier_authority: ScaP12VerifierAuthorityV1;
  readonly release_authority: ScaP12ReleaseAuthorityV1;
  readonly subject_sha256: string;
  /** Derived from verified gate qualification/reviewer records and exact P11 report/host lineage. */
  readonly excluded_identity_ids: readonly string[];
  readonly excluded_lineage_ids: readonly string[];
  /** False when the host could not derive exclusions from verified records (fail closed). */
  readonly exclusions_available: boolean;
  /** True only when the verifier authority was resolved from a current host authority. */
  readonly verifier_authority_current: boolean;
}): ScaP12IndependenceResultV1 {
  const verifier = validateScaP12VerifierAuthorityV1(input.verifier_authority);
  const release = input.release_authority;
  const excludedIdentities = new Set(input.excluded_identity_ids);
  const excludedLineages = new Set(input.excluded_lineage_ids);
  const blockers: string[] = [];

  const declaredCoversDerived =
    [...excludedIdentities].every((id) => verifier.excluded_identity_ids.includes(id)) &&
    [...excludedLineages].every((id) => verifier.excluded_lineage_ids.includes(id));
  if (!declaredCoversDerived) blockers.push("p12_verifier_exclusion_declaration_incomplete");

  const separated =
    input.exclusions_available &&
    verifier.verifier_identity_id !== verifier.verifier_lineage_id &&
    !excludedIdentities.has(verifier.verifier_identity_id) &&
    !excludedLineages.has(verifier.verifier_lineage_id) &&
    !excludedIdentities.has(verifier.verifier_lineage_id) &&
    !excludedLineages.has(verifier.verifier_identity_id);
  if (!separated) blockers.push("p12_verifier_not_independent");

  const subset =
    verifier.allowed_tools.length === 0 &&
    verifier.allowed_relative_paths.length === 0 &&
    verifier.external_mutations === "forbidden" &&
    verifier.filesystem_writes === "host_policy_only" &&
    same(verifier.required_model, SCA_P12_REQUIRED_MODEL);
  if (!subset) blockers.push("p12_verifier_authority_not_subset");

  const current =
    input.verifier_authority_current &&
    verifier.decision === "authorized" &&
    verifier.subject_sha256 === input.subject_sha256;
  if (!current) blockers.push("p12_verifier_authority_not_current");

  const releaseValid =
    release.decision === "authorized" &&
    release.publication_authority === "separate_unmet" &&
    release.subject_sha256 === input.subject_sha256;
  if (!releaseValid) blockers.push("p12_release_authority_invalid");

  const releaseDistinct =
    release.release_authority_identity_id !== verifier.verifier_identity_id &&
    release.release_authority_lineage_id !== verifier.verifier_lineage_id &&
    release.release_authority_identity_id !== release.release_authority_lineage_id &&
    !excludedIdentities.has(release.release_authority_identity_id) &&
    !excludedLineages.has(release.release_authority_lineage_id);
  if (!releaseDistinct) blockers.push("p12_release_authority_not_distinct");

  return {
    verifier_independent: separated,
    verifier_subset_authority: subset,
    verifier_authority_current: current,
    release_authority_valid: releaseValid,
    release_authority_distinct: releaseDistinct,
    blocker_codes: uniqueSortedStrings(blockers),
  };
}

// --- Deterministic replay ---------------------------------------------------------------------

export interface ScaP12ReplayFactsV1 {
  readonly set_equality_valid: boolean;
  readonly deterministic_validation_passed: boolean;
  readonly no_unresolved_required_item: boolean;
  readonly checksum_manifest_valid: boolean;
  readonly obligation_ledger_complete: boolean;
  readonly latest_revision_only: boolean;
  readonly release_claim_absent: boolean;
}

export interface ScaP12ReplayResultV1 {
  readonly evidence: ScaP12ReplayEvidenceV1;
  readonly facts: ScaP12ReplayFactsV1;
}

interface CheckRecord {
  readonly check_id: string;
  readonly expected_digest: string;
  readonly observed_digest: string;
  readonly passed: boolean;
  readonly detail: string;
}

function gatePredicateAgreement(
  recorded: boolean,
  recomputed: boolean,
  key: string,
  blockers: string[]
): boolean {
  if (recorded !== recomputed) {
    blockers.push(`p12_p11_gate_predicate_${key}_disagrees`);
    return false;
  }
  return true;
}

/**
 * Deterministic host-side replay and spot-check over exact immutable evidence (P12-R11/R12/R13). It
 * re-derives every check from exact bytes — never from a stored PASS label — and records each
 * expected/observed digest. Any failed check blocks `pass_ready`; failures are retained.
 */
export function buildScaP12ReplayEvidenceV1(input: {
  readonly store: ArtifactHostStore;
  readonly run_id: string;
  readonly revision: number;
  readonly replay_lineage_id: string;
  readonly admission: ScaP12AdmissionResultV1;
  readonly verification_scope: ScaP12VerificationScopeV1;
}): ScaP12ReplayResultV1 {
  const { store, admission } = input;
  const scope = validateScaP12VerificationScopeV1(input.verification_scope);
  if (!admission.reportable || admission.lane === null) {
    throw new Error("P12 replay requires a reportable P11 admission");
  }
  const report = admission.report;
  const reconciliation = admission.reconciliation;
  const validation = admission.validation;
  const p11Gate = admission.p11_gate;
  const checksum = admission.checksum;
  const obligationLedger = admission.obligation_ledger;
  if (
    report === null ||
    reconciliation === null ||
    validation === null ||
    p11Gate === null ||
    checksum === null ||
    obligationLedger === null
  ) {
    throw new Error("P12 replay requires the complete recorded P11 report set");
  }

  const reportJson = validateScaP11ReportJsonV1(JSON.parse(readText(store, report.json_ref)));
  const sarif = validateScaP11ReportSarifV1(JSON.parse(readText(store, report.sarif_ref)));
  const markdown = readText(store, report.markdown_ref);
  const scoring = validateScaP11ScoringRecordsV1(
    JSON.parse(readText(store, report.scoring_records_ref))
  );

  const checks: CheckRecord[] = [];
  const facts = {
    set_equality_valid: true,
    deterministic_validation_passed: true,
    no_unresolved_required_item: admission.no_unresolved_required_item,
    checksum_manifest_valid: true,
    obligation_ledger_complete: obligationLedger.uncovered_obligation_ids.length === 0,
    latest_revision_only: true,
    release_claim_absent: true,
  };
  const push = (check_id: string, expected: unknown, observed: unknown, detail: string): void => {
    checks.push({
      check_id,
      expected_digest: digest(expected),
      observed_digest: digest(observed),
      passed: same(expected, observed),
      detail,
    });
  };

  const record = (
    check_id: string,
    passed: boolean,
    expected: unknown,
    observed: unknown,
    detail: string
  ): void => {
    checks.push({
      check_id,
      expected_digest: digest(expected),
      observed_digest: digest(observed),
      passed,
      detail,
    });
  };

  // 1. Markdown byte equality (re-render from the exact report JSON).
  const reRendered = renderScaP11MarkdownV1(reportJson);
  checks.push({
    check_id: "p11_markdown_byte_equal",
    expected_digest: sha256(markdown),
    observed_digest: sha256(reRendered),
    passed: markdown === reRendered,
    detail: "the persisted P11 Markdown projection must byte-equal the deterministic re-render",
  });

  // 2. Re-derived P11 admission equals the recorded report/handoff sets.
  push(
    "p11_admission_reportable",
    { reportable: true, lane: report.lane, status: report.status },
    {
      reportable: admission.rederived?.reportable ?? false,
      lane: admission.rederived?.lane ?? null,
      status: report.status,
    },
    "the re-derived P11 admission must agree with the recorded report lane and status"
  );

  // 3. Report JSON is exact and self-consistent.
  checks.push({
    check_id: "p11_report_json_valid",
    expected_digest: report.json_ref.content_digest,
    observed_digest: sha256(canonicalJson(reportJson)),
    passed: report.json_ref.content_digest === sha256(canonicalJson(reportJson)),
    detail: "the persisted P11 report JSON must match its exact bound digest",
  });

  // 4. SARIF is exact.
  checks.push({
    check_id: "p11_sarif_valid",
    expected_digest: report.sarif_ref.content_digest,
    observed_digest: sha256(canonicalJson(sarif)),
    passed: report.sarif_ref.content_digest === sha256(canonicalJson(sarif)),
    detail: "the persisted P11 SARIF must match its exact bound digest",
  });

  // 5. Reconciliation set equality across report JSON, reconciliation, and SARIF.
  const expectedFindingIds = uniqueSortedStrings(
    reconciliation.rows.filter((row) => row.reportable).map((row) => scaP11FindingId(row.identity))
  );
  const reportFindingIds = uniqueSortedStrings(
    reportJson.findings.map((finding) => finding.finding_id)
  );
  const sarifFindingIds = uniqueSortedStrings(sarif.results.map((result) => result.finding_id));
  const setEquality =
    same(expectedFindingIds, reportFindingIds) && same(expectedFindingIds, sarifFindingIds);
  facts.set_equality_valid = setEquality;
  record(
    "p11_reconciliation_set_equal",
    setEquality,
    expectedFindingIds,
    { report: reportFindingIds, sarif: sarifFindingIds },
    "the reportable reconciliation set, report JSON findings, and SARIF results must be equal"
  );

  // 6. Deterministic validation reproduced.
  const recomputedChecks = validateScaP11Deterministic({
    report: reportJson,
    sarif,
    reconciliation,
    markdown,
  });
  const recomputedAllPassed = recomputedChecks.every((check) => check.passed);
  facts.deterministic_validation_passed = recomputedAllPassed;
  const persistedChecks = [...validation.deterministic_checks]
    .map((check) => ({ check_id: check.check_id, passed: check.passed }))
    .sort((left, right) => left.check_id.localeCompare(right.check_id));
  const reRunChecks = [...recomputedChecks]
    .map((check) => ({ check_id: check.check_id, passed: check.passed }))
    .sort((left, right) => left.check_id.localeCompare(right.check_id));
  record(
    "p11_validation_reproduced",
    same(persistedChecks, reRunChecks),
    persistedChecks,
    reRunChecks,
    "re-running the deterministic P11 validation must reproduce the persisted check results"
  );

  // 7. Scoring records bound to the exact admitted scorer qualification.
  let scoringBound = scoring.scorer_authority_admitted && scoring.scorer_qualification_ref !== null;
  if (scoringBound && scoring.scorer_qualification_ref !== null) {
    try {
      const authority = resolveScaP11CvssScorerAuthority({
        store,
        ref: scoring.scorer_qualification_ref,
      });
      scoringBound =
        authority.qualification_ref !== null &&
        scoring.scorer_qualification_sha256 === authority.qualification.qualification_sha256;
    } catch {
      scoringBound = false;
    }
  }
  checks.push({
    check_id: "p11_scoring_records_bound",
    expected_digest: digest({ admitted: true, records: scoring.record_count }),
    observed_digest: digest({ admitted: scoringBound, records: scoring.records.length }),
    passed: scoringBound,
    detail:
      "the P11 scoring records must bind the exact admitted CVSS scorer qualification receipt",
  });

  // 8. Checksum manifest resolves exactly.
  let checksumValid = true;
  for (const entry of checksum.artifacts) {
    const stored = store.refById(entry.artifact_id);
    if (stored === undefined || stored.kind !== entry.kind) {
      checksumValid = false;
      break;
    }
    const bytes = store.readById(entry.artifact_id);
    if (
      bytes.byteLength !== entry.byte_length ||
      sha256(bytes) !== entry.content_digest ||
      stored.content_digest !== entry.content_digest
    ) {
      checksumValid = false;
      break;
    }
  }
  facts.checksum_manifest_valid = checksumValid;
  checks.push({
    check_id: "p11_checksum_manifest_resolved",
    expected_digest: checksum.manifest_sha256,
    observed_digest: digest({ resolved: checksumValid, count: checksum.artifacts.length }),
    passed: checksumValid,
    detail:
      "every bound checksum artifact must resolve and match its kind, digest, and byte length",
  });

  // 9. P11 gate self-consistency.
  const gateLaneAgreement =
    (report.status === "complete" && p11Gate.verdict === "pass_ready") ||
    (report.status === "incomplete" && p11Gate.verdict !== "pass_ready");
  const gateBinding =
    p11Gate.report_ref !== null &&
    p11Gate.report_ref.artifact_id === (admission.admission.p11_report_ref?.artifact_id ?? "");
  record(
    "p11_gate_self_consistent",
    gateBinding && gateLaneAgreement,
    { bound: true, laneAgreement: true },
    { bound: gateBinding, laneAgreement: gateLaneAgreement },
    "the recorded P11 gate verdict must agree with the report status and bind the report projection"
  );

  // 10. P11 gate predicates reproduced where structurally checkable.
  const predicateBlockers: string[] = [];
  const compared = [
    ["set_equality_valid", p11Gate.set_equality_valid, facts.set_equality_valid],
    [
      "deterministic_validation_passed",
      p11Gate.deterministic_validation_passed,
      facts.deterministic_validation_passed,
    ],
    [
      "no_unresolved_required_item",
      p11Gate.no_unresolved_required_item,
      facts.no_unresolved_required_item,
    ],
    ["checksum_manifest_valid", p11Gate.checksum_manifest_valid, facts.checksum_manifest_valid],
  ] as const;
  let predicatesOk = true;
  for (const [key, recorded, recomputed] of compared) {
    if (!gatePredicateAgreement(recorded, recomputed, key, predicateBlockers)) predicatesOk = false;
  }
  record(
    "p11_gate_predicates_reproduced",
    predicatesOk,
    compared.map(([key, recorded]) => ({ key, recorded })),
    compared.map(([key, , recomputed]) => ({ key, recomputed })),
    predicateBlockers.length === 0
      ? "every independently checkable P11 gate predicate agrees with the recorded gate"
      : predicateBlockers.join(",")
  );

  // 11. P11 terminal remains non-positive.
  const terminalNonPositive =
    admission.p11_terminal.phase_gate_passed === false &&
    admission.p11_terminal.release_eligible === false &&
    admission.p11_terminal.campaign_complete === false &&
    admission.p11_terminal.p12_release_authorized === false;
  record(
    "p11_terminal_non_positive",
    terminalNonPositive,
    { nonPositive: true },
    { nonPositive: terminalNonPositive },
    "the recorded P11 terminal must remain non-positive and never authorize a P12 release"
  );

  // 12. Latest revision only.
  const revisions = [
    reportJson.revision,
    sarif.revision,
    reconciliation.revision,
    validation.revision,
    scoring.revision,
    report.latest_revision,
  ];
  const revisionsEqual = revisions.every((value) => value === report.latest_revision);
  facts.latest_revision_only = revisionsEqual;
  record(
    "latest_revision_only",
    revisionsEqual,
    { revision: report.latest_revision },
    { revisions: uniqueSortedStrings(revisions.map((value) => String(value))) },
    "the report, SARIF, validation, reconciliation, scoring and projection revisions must be equal"
  );

  // 13. Release/publication claims absent from the P11 projections.
  const claimScan = [
    markdown,
    canonicalJson(reportJson),
    canonicalJson(sarif),
    canonicalJson(p11Gate),
  ]
    .join("\n")
    .toLowerCase();
  const claimAbsent =
    !/\brelease authorized\b/.test(claimScan) &&
    !/\bpublication (?:authorized|performed|complete)\b/.test(claimScan) &&
    !/\bcampaign complete\b/.test(claimScan) &&
    !/\bproduct (?:is )?qualified\b/.test(claimScan);
  facts.release_claim_absent = claimAbsent;
  record(
    "p11_release_claim_absent",
    claimAbsent,
    { claimsAbsent: true },
    { claimsAbsent: claimAbsent },
    "no P11 projection may assert a release, publication, campaign-completion, or product-qualification claim"
  );

  // 14. Deterministic spot-check of finding evidence/source refs.
  const sample = deterministicSpotCheckSample(
    reportFindingIds,
    scope.spot_check.threshold,
    scope.spot_check.sample_size
  );
  const sampledIdentities: string[] = [];
  // A non-empty finding/evidence presence must always yield a non-empty sample (P12-R12/A9).
  let spotCheckPassed = reportFindingIds.length === 0 || sample.size > 0;
  for (const finding of reportJson.findings) {
    if (!sample.has(finding.finding_id)) continue;
    sampledIdentities.push(finding.identity);
    for (const ref of [...finding.evidence_refs, ...finding.source_refs]) {
      if (!exactReadable(store, ref)) {
        spotCheckPassed = false;
        break;
      }
    }
    if (!spotCheckPassed) break;
  }
  checks.push({
    check_id: "spot_check_exact_readable",
    expected_digest: digest({ sample: [...sample].sort() }),
    observed_digest: digest({ readable: spotCheckPassed, sampled: sampledIdentities.length }),
    passed: spotCheckPassed,
    detail:
      "every sampled finding's evidence and source refs must be exact-readable; empty, foreign, or unreadable evidence fails",
  });

  const allPassed = checks.every((check) => check.passed);
  const evidence = validateScaP12ReplayEvidenceV1(
    withP12Digest(
      {
        schema_id: SCA_P12_REPLAY_EVIDENCE_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P12" as const,
        run_id: input.run_id,
        revision: input.revision,
        replay_lineage_id: input.replay_lineage_id,
        checks: [...checks].sort((left, right) =>
          left.check_id < right.check_id ? -1 : left.check_id > right.check_id ? 1 : 0
        ),
        sampled_identity_ids: uniqueSortedStrings(sampledIdentities),
        spot_check_passed: spotCheckPassed,
        passed: allPassed,
        evidence_refs: [
          admission.admission.p11_terminal_ref,
          report.json_ref,
          report.markdown_ref,
          report.sarif_ref,
          report.reconciliation_ref,
          report.validation_records_ref,
          report.checksum_manifest_ref,
          report.obligation_ledger_ref,
          ...(report.scoring_records_ref === null ? [] : [report.scoring_records_ref]),
          ...admission.evidence_refs,
        ]
          .reduce<ArtifactRef[]>((acc, ref) => {
            if (!acc.some((candidate) => candidate.artifact_id === ref.artifact_id)) acc.push(ref);
            return acc;
          }, [])
          .sort((left, right) =>
            left.artifact_id < right.artifact_id ? -1 : left.artifact_id > right.artifact_id ? 1 : 0
          ),
      },
      "replay_sha256"
    )
  );
  return { evidence, facts };
}

/** Deterministic, hash-ordered spot-check sample over the sorted finding ids (never cherry-picked).
 * When findings exist the sample is non-empty: an admitted size of zero is clamped to one so that
 * evidence is always examined, and the sample never exceeds the admitted finding count. */
export function deterministicSpotCheckSample(
  sortedFindingIds: readonly string[],
  threshold: number,
  sampleSize: number
): ReadonlySet<string> {
  if (sortedFindingIds.length === 0) return new Set();
  if (sortedFindingIds.length < threshold) return new Set(sortedFindingIds);
  const ordered = [...sortedFindingIds].sort((left, right) => {
    const leftHash = sha256(left);
    const rightHash = sha256(right);
    return leftHash === rightHash ? left.localeCompare(right) : leftHash.localeCompare(rightHash);
  });
  const effectiveSize = Math.min(Math.max(sampleSize, 1), ordered.length);
  return new Set(ordered.slice(0, effectiveSize));
}

// --- Verifier verdicts ------------------------------------------------------------------------

export interface ScaP12VerdictEvaluationV1 {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly blocking_open_items: readonly string[];
}

export interface ScaP12DimensionFactsV1 {
  readonly scope_complete: boolean;
  readonly independence: ScaP12IndependenceResultV1;
  readonly replay_passed: boolean;
  readonly spot_check_passed: boolean;
  readonly phase_gate_complete: boolean;
  readonly obligation_ledger_complete: boolean;
  readonly set_equality: boolean;
  readonly no_unresolved: boolean;
  readonly identity_valid: boolean;
  readonly stale_free: boolean;
  readonly release_claims_absent: boolean;
}

export interface ScaP12VerdictsResultV1 {
  readonly verdicts: ScaP12VerifierVerdictsV1;
  readonly evaluation: ScaP12VerdictEvaluationV1;
}

function dimensionVerdict(
  dimension: ScaP12DimensionV1,
  facts: ScaP12DimensionFactsV1
): { readonly verdict: ScaP12VerdictV1; readonly reason: string } {
  const yes = (reason: string): { verdict: ScaP12VerdictV1; reason: string } => ({
    verdict: "supported",
    reason,
  });
  const no = (reason: string): { verdict: ScaP12VerdictV1; reason: string } => ({
    verdict: "refuted",
    reason,
  });
  switch (dimension) {
    case "identity_lineage_separation":
      return facts.independence.verifier_independent
        ? yes("the verifier identity and lineage are separated from every excluded identity")
        : no("the verifier identity or lineage coincides with a report-production identity");
    case "verifier_authority_subset":
      return facts.independence.verifier_subset_authority &&
        facts.independence.verifier_authority_current
        ? yes("the verifier holds the exact strict-subset no-authority surface")
        : no("the verifier authority exceeds the strict-subset surface or is stale");
    case "provenance_scope_completeness":
      return facts.scope_complete
        ? yes(
            "the verification scope covers the exact dimension set and the P11 provenance is complete"
          )
        : no("the verification scope or P11 provenance is incomplete");
    case "phase_gate_evidence":
      return facts.phase_gate_complete
        ? yes(
            "every AC-P01..AC-P11 gate is accepted and bound by exact ref in the phase-gate index"
          )
        : no("the phase-gate index is missing an accepted AC-Pnn gate");
    case "obligation_ledger_closure":
      return facts.obligation_ledger_complete
        ? yes(
            "SCA-OBL-P12-ACCEPTANCE and the boundary obligations are covered with no uncovered required result"
          )
        : no("a required P12 obligation is uncovered");
    case "accepted_set_projection_consistency":
      return facts.set_equality
        ? yes("the reportable reconciliation set, report JSON, and SARIF results are set-equal")
        : no("the accepted-set projection is inconsistent across representations");
    case "unresolved_work_status":
      return facts.no_unresolved
        ? yes("the P11 report retains no unresolved required item")
        : no("the P11 report retains unresolved required work");
    case "artifact_identity_digest_binding":
      return facts.identity_valid
        ? yes("every bound artifact resolves with an exact kind, digest, and byte-length match")
        : no("a bound artifact identity, digest, or byte length is invalid");
    case "stale_mutated_misbound_report":
      return facts.stale_free
        ? yes(
            "the verification is bound to the exact latest revision with no mutation or misbinding"
          )
        : no("the report is stale, mutated, or misbound");
    case "campaign_completion_claim_absence":
      return facts.release_claims_absent
        ? yes(
            "no release, publication, campaign-completion, or product-qualification claim is present"
          )
        : no("an unsupported release, publication, completion, or qualification claim is present");
    default:
      return no(`unresolved dimension '${dimension satisfies never}'`);
  }
}

/**
 * Deterministic verifier verdict production (P12-R14). The verifier cites only exact refs from each
 * dimension's host-assigned allowlist; it never sets the gate verdict.
 */
export function buildScaP12VerifierVerdictsV1(input: {
  readonly store: ArtifactHostStore;
  readonly run_id: string;
  readonly revision: number;
  readonly verification_scope: ScaP12VerificationScopeV1;
  readonly facts: ScaP12DimensionFactsV1;
}): ScaP12VerdictsResultV1 {
  const scope = validateScaP12VerificationScopeV1(input.verification_scope);
  const byDimension = new Map(scope.dimensions.map((entry) => [entry.dimension_id, entry]));
  const verdicts = [...SCA_P12_DIMENSIONS].sort().map((dimension) => {
    const entry = byDimension.get(dimension);
    if (entry === undefined) {
      throw new Error(`SCA P12 verification scope omits dimension '${dimension}'`);
    }
    const result = dimensionVerdict(dimension, input.facts);
    const evidence = entry.evidence_allowlist.filter((ref) => exactReadable(input.store, ref));
    return {
      dimension_id: dimension,
      verdict: result.verdict,
      reason: result.reason,
      evidence_refs: evidence.slice(0, 16),
    };
  });
  const verdictsRecord = validateScaP12VerifierVerdictsV1(
    withP12Digest(
      {
        schema_id: SCA_P12_VERIFIER_VERDICTS_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P12" as const,
        run_id: input.run_id,
        revision: input.revision,
        verification_scope_sha256: scope.scope_sha256,
        verdicts,
        open_items: [] as const,
        gate_verdict_set: false as const,
        complete: true as const,
      },
      "verdicts_sha256"
    )
  );
  const evaluation = evaluateScaP12VerifierVerdictsV1({
    store: input.store,
    verification_scope: scope,
    verdicts: verdictsRecord,
  });
  return { verdicts: verdictsRecord, evaluation };
}

/**
 * Deterministic host evaluation of a verdict set against the host-assigned scope (P12-R15/R16). A
 * missing verdict, a foreign or unreadable ref, an empty evidence set, `refuted`, `insufficient`, or
 * any blocking open item becomes a blocking failure; only all-`supported` with non-empty exact
 * evidence and no blocking open item may contribute `verified = true`.
 */
export function evaluateScaP12VerifierVerdictsV1(input: {
  readonly store: ArtifactHostStore;
  readonly verification_scope: ScaP12VerificationScopeV1;
  readonly verdicts: ScaP12VerifierVerdictsV1;
}): ScaP12VerdictEvaluationV1 {
  const scope = validateScaP12VerificationScopeV1(input.verification_scope);
  const verdicts = validateScaP12VerifierVerdictsV1(input.verdicts);
  if (verdicts.verification_scope_sha256 !== scope.scope_sha256) {
    return {
      passed: false,
      failures: ["p12_verdicts_scope_digest_mismatch"],
      blocking_open_items: [],
    };
  }
  const byDimension = new Map(scope.dimensions.map((entry) => [entry.dimension_id, entry]));
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const dimension of SCA_P12_DIMENSIONS) {
    const verdict = verdicts.verdicts.find((entry) => entry.dimension_id === dimension);
    if (verdict === undefined) {
      failures.push(`p12_verdict_missing_${dimension}`);
      continue;
    }
    seen.add(dimension);
    const allowlist = byDimension.get(dimension)?.evidence_allowlist ?? [];
    const allowedIds = new Set(allowlist.map((ref) => ref.artifact_id));
    if (verdict.evidence_refs.length === 0) {
      failures.push(`p12_verdict_empty_evidence_${dimension}`);
    }
    for (const ref of verdict.evidence_refs) {
      if (!allowedIds.has(ref.artifact_id) || !exactReadable(input.store, ref)) {
        failures.push(`p12_verdict_foreign_or_unreadable_evidence_${dimension}`);
      }
    }
    if (verdict.verdict !== "supported") {
      failures.push(`p12_verdict_${verdict.verdict}_${dimension}`);
    }
  }
  if (verdicts.verdicts.length !== seen.size || seen.size !== SCA_P12_DIMENSIONS.length) {
    failures.push("p12_verdict_over_or_under_coverage");
  }
  const blockingOpenItems = verdicts.open_items
    .filter((item) => item.severity === "blocking")
    .map((item) => item.open_item_id)
    .sort();
  const uniqueFailures = uniqueSortedStrings(failures);
  return {
    passed: uniqueFailures.length === 0 && blockingOpenItems.length === 0,
    failures: uniqueFailures,
    blocking_open_items: blockingOpenItems,
  };
}

export type { ScaP12OpenItemDispositionV1 };
