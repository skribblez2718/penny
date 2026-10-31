import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import path from "node:path";
import { RunContext } from "../dist/context.js";
import {
  validateContract,
  type ArtifactRef,
  type Directive,
  type JsonValue,
  type OutputArtifactMetadata,
  type StartRequest,
} from "../dist/contracts.js";
import {
  SCA_P09_CANDIDATE_PLAYBOOK_NAME,
  SCA_P09_CANDIDATE_REGISTRATION,
} from "../dist/sca/p09-playbook.js";
import type { PlaybookRegistration } from "../dist/playbooks/registry.js";
import {
  SCA_P02_OPERATION_IDS,
  ScaP02SemgrepJsTsResultV1Schema,
  ScaP02SemgrepPhpResultV1Schema,
} from "../dist/sca/p02-contracts.js";
import {
  SCA_P01_RULE_BUNDLE_V1_SCHEMA,
  SCA_RULE_RELEASE_V1_SCHEMA,
  validateScaP01RuleBundleV1,
  validateScaRuleReleaseV1,
} from "../dist/sca/p01-policy-contracts.js";
import {
  SCA_P10_BASELINE_EVIDENCE_SCHEMA,
  SCA_P10_CANDIDATE_START_SCHEMA,
  SCA_P10_DISCLOSURE_SCOPE_SCHEMA,
  SCA_P10_PROMOTION_AUTHORITY_SCHEMA,
  validateScaP10BaselineEvidenceV1,
  validateScaP10CandidateStartV1,
  validateScaP10DisclosureScopeV1,
  validateScaP10PromotionAuthorityV1,
  withP10Digest,
  type ScaP10BaselineLanguageV1,
  type ScaP10CandidateStartV1,
} from "../dist/sca/p10-contracts.js";
import { scaP10RuleReleaseBindingSha256 } from "../dist/sca/p10-admission.js";
import type { ScaP09LineageV1 } from "./sca-p09-lineage.js";

/**
 * Focused test-only P09→P10 lineage builder. It reuses the exact P09 lineage fixture (with located
 * confirmed dispositions), persists exact P02 Semgrep baseline evidence, a frozen P01 rule release,
 * a P10 disclosure scope, and a promotion authority, then assembles the closed P10 start
 * constraints. It calls no model, broker, tool, or VM.
 */
const NOW = "2026-09-26T00:00:05.000Z";
const TENANT = "tenant";
const PROJECT = "project";
const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");

export interface ScaP10BaselineAlertV1 {
  readonly language: ScaP10BaselineLanguageV1;
  readonly path: string;
  readonly start_line: number;
}

export interface ScaP10LineageInputV1 {
  readonly store: ArtifactStore;
  readonly p09: ScaP09LineageV1;
  /** Exact P09 result refs produced by driving the P09 candidate playbook over this lineage. */
  readonly p09_result: ScaP10P09ResultV1;
  /** Baseline languages to include. A language omitted is a coverage gap. */
  readonly baseline_languages?: readonly ScaP10BaselineLanguageV1[];
  /** Alerts emitted by the baseline scan. */
  readonly baseline_alerts?: readonly ScaP10BaselineAlertV1[];
  /** Languages whose exact P02 baseline is `blocked` (a coverage gap). */
  readonly baseline_blocked_languages?: readonly ScaP10BaselineLanguageV1[];
  /** Languages whose exact P02 analyzer reports `not_applicable` (a coverage gap). */
  readonly baseline_not_applicable_languages?: readonly ScaP10BaselineLanguageV1[];
  /** Languages whose exact P02 result binds a different source snapshot (a coverage gap). */
  readonly baseline_snapshot_mismatch_languages?: readonly ScaP10BaselineLanguageV1[];
  readonly promotion_decision?: "allow" | "deny";
  readonly active_run_rule_release_refs?: readonly ArtifactRef[];
}

export interface ScaP10P09ResultV1 {
  readonly terminal_ref: ArtifactRef;
  readonly transition_ref: ArtifactRef | null;
  readonly ledger_ref: ArtifactRef | null;
  readonly gate_ref: ArtifactRef | null;
  readonly admission_ref: ArtifactRef | null;
}

export interface ScaP10LineageV1 {
  readonly run_id: string;
  readonly p09: ScaP09LineageV1;
  readonly constraints: ScaP10CandidateStartV1;
  readonly source_snapshot_ref: ArtifactRef;
  readonly frozen_rule_release_ref: ArtifactRef;
  readonly baseline_evidence_ref: ArtifactRef;
  readonly disclosure_scope_ref: ArtifactRef;
  readonly promotion_authority_ref: ArtifactRef;
  readonly active_run_rule_release_refs: readonly ArtifactRef[];
}

function save(input: {
  readonly store: ArtifactStore;
  readonly run_id: string;
  readonly phase: string;
  readonly kind: string;
  readonly operation_id: string;
  readonly schema_id: string;
  readonly schema_version?: number;
  readonly value: unknown;
  readonly producer?: string;
  readonly upstream_refs?: readonly ArtifactRef[];
}): ArtifactRef {
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.run_id,
    phase: input.phase,
    branch_id: null,
    kind: input.kind,
    operation_id: input.operation_id,
    version: 1,
    producer: input.producer ?? "host:sca-p10-lineage",
    media_type: "application/json",
    content_schema: { schema_id: input.schema_id, schema_version: input.schema_version ?? 1 },
    parent_ref: null,
    upstream_refs: [...(input.upstream_refs ?? [])],
  };
  return input.store.persist({ metadata, content: canonicalJson(input.value) });
}

function semgrepResult(input: {
  readonly run_id: string;
  readonly language: ScaP10BaselineLanguageV1;
  readonly blocked: boolean;
  readonly applicable: boolean;
  readonly sourceSnapshotSha256: string;
  readonly alerts: readonly { readonly path: string; readonly start_line: number }[];
}): unknown {
  const analyzerId = input.language === "php" ? "semgrep-php" : "semgrep-js-ts";
  const operationId =
    input.language === "php"
      ? SCA_P02_OPERATION_IDS.semgrep_php
      : SCA_P02_OPERATION_IDS.semgrep_js_ts;
  const recordId = `p02raw_${sha256(`${input.run_id}:${input.language}:record`)}`;
  const evidenceId = `p02e_${sha256(`${input.run_id}:${input.language}:evidence`)}`;
  const observations = input.alerts.map((alert, index) => {
    const fingerprint = sha256(`${alert.path}:${String(alert.start_line)}:${String(index)}`);
    return {
      observation_id: `scaobs_${fingerprint}`,
      analyzer_id: analyzerId,
      category: "baseline-finding",
      severity: "high",
      subject: `${alert.path}:${String(alert.start_line)}`,
      path: alert.path,
      start_line: alert.start_line,
      advisory_id: null,
      fingerprint_sha256: fingerprint,
      raw_evidence_ids: [evidenceId],
      raw_record_ids: [recordId],
      correlation_id: `p02corr_${sha256(`corr:${fingerprint}`)}`,
      duplicate_group_id: null,
      provenance_sha256: sha256(`provenance:${fingerprint}`),
    };
  });
  const schema =
    input.language === "php" ? ScaP02SemgrepPhpResultV1Schema : ScaP02SemgrepJsTsResultV1Schema;
  return validateContract(
    schema,
    {
      schema_id:
        input.language === "php"
          ? "penny.sca-p02-semgrep-php-result.v1"
          : "penny.sca-p02-semgrep-js-ts-result.v1",
      schema_version: 1,
      run_id: input.run_id,
      operation_id: operationId,
      request_sha256: sha256(`request:${input.language}`),
      source_binding_sha256: input.sourceSnapshotSha256,
      isolation_id: "isolation",
      isolation_runtime_id: "runtime",
      isolation_runtime_kind: "simulated_test_runtime",
      isolation_qualification_scope: "deterministic_test_only",
      isolation_profile_id: "profile",
      isolation_profile_sha256: sha256("profile"),
      isolation_implementation_sha256: sha256("implementation"),
      isolation_deployment_sha256: sha256("deployment"),
      isolation_host_attestation_id: null,
      isolation_host_attestation_sha256: null,
      isolation_host_attestation_ref: null,
      status: input.blocked ? "blocked" : "complete",
      analyzer_results: [
        {
          analyzer_id: analyzerId,
          applicability: input.applicable ? "applicable" : "not_applicable",
          status: input.blocked ? "blocked" : "complete",
          fresh: true,
          blocker_codes: [],
        },
      ],
      raw_evidence: [
        {
          evidence_id: evidenceId,
          analyzer_id: analyzerId,
          content_schema_id: "penny.sca-p02-semgrep-raw.v1",
          content_schema_version: 1,
          media_type: "application/json",
          encoding: "base64",
          content_base64: Buffer.from("{}").toString("base64"),
          content_sha256: sha256("{}"),
          byte_length: 2,
          retention: "exact",
          original_content_sha256: null,
          original_byte_length: null,
          raw_record_ids: [recordId],
        },
      ],
      raw_records: [
        {
          raw_record_id: recordId,
          evidence_id: evidenceId,
          analyzer_id: analyzerId,
          record_kind: "summary",
          source_pointer: "raw",
          record_sha256: sha256("record"),
        },
      ],
      normalized_observations: observations,
      correlations: [
        {
          correlation_id: `p02corr_${sha256(`corr:${input.language}`)}`,
          analyzer_id: analyzerId,
          normalized_observation_id: observations[0]?.observation_id ?? null,
          raw_record_ids: [recordId],
          disposition: "normalized",
          disposition_code: null,
          duplicate_group_id: null,
        },
      ],
      freshness: { fetched_at: NOW, max_age_seconds: 86_400, expires_at: null },
      completed_at: NOW,
      operation_kind: input.language === "php" ? "semgrep_php" : "semgrep_js_ts",
    },
    "SCA P10 baseline P02 result"
  );
}

function buildFrozenRuleRelease(input: {
  readonly store: ArtifactStore;
  readonly run_id: string;
}): { readonly releaseRef: ArtifactRef; readonly ruleReleaseBindingSha256: string } {
  const bundle = validateScaP01RuleBundleV1({
    schema_id: SCA_P01_RULE_BUNDLE_V1_SCHEMA,
    schema_version: 1,
    bundle_id: "baseline-bundle",
    release_id: "baseline-release",
    immutable: true,
    rules: [
      {
        rule_id: "baseline-rule",
        language: "php",
        encoding: "base64",
        content_base64: Buffer.from("rules: []\n").toString("base64"),
        content_sha256: sha256("rules: []\n"),
      },
    ],
  });
  const bundleRef = save({
    store: input.store,
    run_id: input.run_id,
    phase: "SCA-P01",
    kind: "sca-p01-rule-bundle",
    operation_id: "sca-p10-baseline-rule-bundle",
    schema_id: SCA_P01_RULE_BUNDLE_V1_SCHEMA,
    value: bundle,
  });
  const release = validateScaRuleReleaseV1({
    schema_id: SCA_RULE_RELEASE_V1_SCHEMA,
    schema_version: 1,
    release_id: "baseline-release",
    trust_status: "host-declared",
    status: "approved",
    immutable: true,
    languages: ["php"],
    rule_count: 1,
    rule_bundle_ref: bundleRef,
    rules_sha256: bundleRef.content_digest,
  });
  const releaseRef = save({
    store: input.store,
    run_id: input.run_id,
    phase: "SCA-P01",
    kind: "sca-rule-release",
    operation_id: "sca-p10-baseline-rule-release",
    schema_id: SCA_RULE_RELEASE_V1_SCHEMA,
    value: release,
  });
  return {
    releaseRef,
    ruleReleaseBindingSha256: scaP10RuleReleaseBindingSha256({
      release_sha256: releaseRef.content_digest,
      release,
    }),
  };
}

export function buildScaP10Lineage(input: ScaP10LineageInputV1): ScaP10LineageV1 {
  const { store } = input;
  const p09 = input.p09;
  const runId = p09.run_id;

  const sourceSnapshotRef = save({
    store,
    run_id: runId,
    phase: "SCA-P01",
    kind: "source-snapshot",
    operation_id: "sca-p10-source-snapshot",
    schema_id: "penny.sca-campaign-source-snapshot.v2",
    schema_version: 2,
    value: {
      schema_id: "penny.sca-campaign-source-snapshot.v2",
      schema_version: 2,
      snapshot: runId,
    },
  });
  const frozen = buildFrozenRuleRelease({ store, run_id: runId });

  const languages = input.baseline_languages ?? (["php"] as readonly ScaP10BaselineLanguageV1[]);
  const blocked = new Set(input.baseline_blocked_languages ?? []);
  const notApplicable = new Set(input.baseline_not_applicable_languages ?? []);
  const snapshotMismatch = new Set(input.baseline_snapshot_mismatch_languages ?? []);
  const entries = languages.map((language) => {
    const alerts = (input.baseline_alerts ?? [])
      .filter((alert) => alert.language === language)
      .map((alert) => ({ path: alert.path, start_line: alert.start_line }))
      .sort((left, right) =>
        left.path === right.path
          ? left.start_line - right.start_line
          : left.path < right.path
            ? -1
            : 1
      );
    const result = semgrepResult({
      run_id: runId,
      language,
      blocked: blocked.has(language),
      applicable: !notApplicable.has(language),
      sourceSnapshotSha256: snapshotMismatch.has(language)
        ? sha256(`mismatched-snapshot:${language}`)
        : sourceSnapshotRef.content_digest,
      alerts,
    });
    const resultRef = save({
      store,
      run_id: runId,
      phase: "SCA-P02",
      kind: language === "php" ? "sca-p02-semgrep-php-result" : "sca-p02-semgrep-js-ts-result",
      operation_id:
        language === "php" ? "sca-p02-semgrep-php-result" : "sca-p02-semgrep-js-ts-result",
      schema_id:
        language === "php"
          ? "penny.sca-p02-semgrep-php-result.v1"
          : "penny.sca-p02-semgrep-js-ts-result.v1",
      value: result,
    });
    const baselineStatus = blocked.has(language)
      ? "failed"
      : alerts.length > 0
        ? "findings"
        : "succeeded";
    return {
      language,
      p02_result_ref: resultRef,
      p02_result_sha256: resultRef.content_digest,
      baseline_status: baselineStatus,
      truncated: false,
      alerts,
    };
  });
  const baselineEvidence = validateScaP10BaselineEvidenceV1(
    withP10Digest(
      {
        schema_id: SCA_P10_BASELINE_EVIDENCE_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P10" as const,
        run_id: runId,
        frozen_rule_release_ref: frozen.releaseRef,
        frozen_rule_release_sha256: frozen.releaseRef.content_digest,
        frozen_rule_config_sha256: frozen.ruleReleaseBindingSha256,
        source_snapshot_ref: sourceSnapshotRef,
        source_snapshot_sha256: sourceSnapshotRef.content_digest,
        entries,
      },
      "baseline_sha256"
    )
  );
  const baselineEvidenceRef = save({
    store,
    run_id: runId,
    phase: "SCA-P10",
    kind: "sca-p10-baseline-evidence",
    operation_id: "sca-p10-baseline-evidence",
    schema_id: SCA_P10_BASELINE_EVIDENCE_SCHEMA,
    value: baselineEvidence,
  });

  const decision = input.promotion_decision ?? "allow";
  const disclosureScope = validateScaP10DisclosureScopeV1(
    withP10Digest(
      {
        schema_id: SCA_P10_DISCLOSURE_SCOPE_SCHEMA,
        schema_version: 1 as const,
        run_id: runId,
        phase_id: "SCA-P10" as const,
        required_model: {
          schema_version: 1 as const,
          alias: "deepseek-flash" as const,
          provider: "ollama" as const,
          model: "deepseek-v4.1-flash:cloud" as const,
          override: "ollama/deepseek-v4.1-flash:cloud" as const,
        },
        destination_class: "cloud" as const,
        purpose: "p10_rule_candidate_proposal" as const,
        allowed_data_classes: [
          "p09_eligible_established_issue_projections",
          "root_cause_evidence_excerpts",
          "source_pointer_projections",
        ] as const,
        provider_retention_status: "known" as const,
        provider_retention_days: 0,
        provider_logging_status: "disabled" as const,
        provider_logging_days: 0,
        provider_training_use: "prohibited" as const,
        max_payload_bytes_per_call: 786_432,
        max_provider_calls: 1 as const,
        decision: "allow" as const,
        blocker_codes: [],
        issued_at: NOW,
      },
      "scope_sha256"
    )
  );
  const disclosureScopeRef = save({
    store,
    run_id: runId,
    phase: "SCA-P10",
    kind: "sca-p10-disclosure-scope",
    operation_id: "sca-p10-disclosure-scope",
    schema_id: SCA_P10_DISCLOSURE_SCOPE_SCHEMA,
    value: disclosureScope,
  });

  const promotionAuthority = validateScaP10PromotionAuthorityV1(
    withP10Digest(
      {
        schema_id: SCA_P10_PROMOTION_AUTHORITY_SCHEMA,
        schema_version: 1 as const,
        run_id: runId,
        promotion_authority_id: "promotion-authority",
        obligation_id: "SCA-OBL-BOUNDARY-PROMOTION-AUTHORITY" as const,
        separated_from_execution_authority: true as const,
        separated_from_release_authority: true as const,
        decision: decision === "allow" ? ("allow" as const) : ("deny" as const),
        blocker_codes: decision === "allow" ? [] : ["p10_promotion_denied_by_operator"],
        issued_at: NOW,
      },
      "authority_sha256"
    )
  );
  const promotionAuthorityRef = save({
    store,
    run_id: runId,
    phase: "SCA-P10",
    kind: "sca-p10-promotion-authority",
    operation_id: "sca-p10-promotion-authority",
    schema_id: SCA_P10_PROMOTION_AUTHORITY_SCHEMA,
    value: promotionAuthority,
  });

  const constraints = validateScaP10CandidateStartV1({
    schema_id: SCA_P10_CANDIDATE_START_SCHEMA,
    schema_version: 1,
    phase_id: "SCA-P10",
    run_id: runId,
    p09_terminal_ref: input.p09_result.terminal_ref,
    p09_transition_ref: input.p09_result.transition_ref,
    p09_reconciliation_ledger_ref: input.p09_result.ledger_ref,
    p09_gate_ref: input.p09_result.gate_ref,
    p09_admission_ref: input.p09_result.admission_ref,
    ...baseConstraints(p09),
    baseline_evidence_ref: baselineEvidenceRef,
    disclosure_scope_ref: disclosureScopeRef,
    promotion_authority_ref: promotionAuthorityRef,
    active_run_rule_release_refs: [...(input.active_run_rule_release_refs ?? [])],
    p10_reassessment_ref: null,
    p10_prior_ledger_ref: null,
  });

  return {
    run_id: runId,
    p09,
    constraints,
    source_snapshot_ref: sourceSnapshotRef,
    frozen_rule_release_ref: frozen.releaseRef,
    baseline_evidence_ref: baselineEvidenceRef,
    disclosure_scope_ref: disclosureScopeRef,
    promotion_authority_ref: promotionAuthorityRef,
    active_run_rule_release_refs: input.active_run_rule_release_refs ?? [],
  };
}

export { TENANT, PROJECT };

/**
 * The P09 base refs the P10 start constraints need. The caller supplies the P09 result refs from
 * the driven P09 run.
 */
export function baseConstraints(
  p09: ScaP09LineageV1
): Omit<
  ScaP10CandidateStartV1,
  | "schema_id"
  | "schema_version"
  | "phase_id"
  | "run_id"
  | "p09_terminal_ref"
  | "p09_transition_ref"
  | "p09_reconciliation_ledger_ref"
  | "p09_gate_ref"
  | "p09_admission_ref"
  | "baseline_evidence_ref"
  | "disclosure_scope_ref"
  | "promotion_authority_ref"
  | "active_run_rule_release_refs"
  | "p10_reassessment_ref"
  | "p10_prior_ledger_ref"
> {
  return {
    p08_terminal_ref: p09.p08_terminal_ref,
    p08_transition_ref: p09.p08_terminal_status === "cancelled" ? null : p09.p08_transition_ref,
    p08_evidence_ledger_ref:
      p09.p08_terminal_status === "cancelled" ? null : p09.p08_evidence_ledger_ref,
    p08_gate_ref: p09.p08_terminal_status === "cancelled" ? null : p09.p08_gate_ref,
    p08_admission_ref: p09.p08_terminal_status === "cancelled" ? null : p09.p08_admission_ref,
    p08_item_universe_ref:
      p09.p08_terminal_status === "cancelled" ? null : p09.p08_item_universe_ref,
    p01_obligation_ledger_ref: p09.p01_obligation_ledger_ref,
    p09_coverage_input_ref: p09.coverage_input_ref,
    p09_phase_evidence_refs: [...p09.phase_evidence_refs].sort((left, right) =>
      left.artifact_id < right.artifact_id ? -1 : left.artifact_id > right.artifact_id ? 1 : 0
    ),
    p09_obligation_resolution_ref: p09.obligation_resolution_ref,
    p09_reassessment_ref: null,
  };
}

/**
 * Drive the inactive P09 candidate playbook over a P09 lineage to produce the exact P09 result
 * refs the P10 start constraints consume. No model, broker, tool, or VM is invoked.
 */
export function driveScaP09(input: {
  readonly store: ArtifactStore;
  readonly p09: ScaP09LineageV1;
  readonly clock?: string;
  /** Production registration; defaults to the provider-free compatibility fixture. */
  readonly registration?: PlaybookRegistration;
}): ScaP10P09ResultV1 {
  const clock = input.clock ?? NOW;
  const registration = input.registration ?? SCA_P09_CANDIDATE_REGISTRATION;
  const startAdmission = registration.start_admission;
  if (startAdmission === undefined) throw new Error("P09 start admission is absent");
  const constraints: Record<string, JsonValue> = {
    p08_terminal_ref: input.p09.p08_terminal_ref,
    p08_transition_ref:
      input.p09.p08_terminal_status === "cancelled" ? null : input.p09.p08_transition_ref,
    p08_evidence_ledger_ref:
      input.p09.p08_terminal_status === "cancelled" ? null : input.p09.p08_evidence_ledger_ref,
    p08_gate_ref: input.p09.p08_terminal_status === "cancelled" ? null : input.p09.p08_gate_ref,
    p08_admission_ref:
      input.p09.p08_terminal_status === "cancelled" ? null : input.p09.p08_admission_ref,
    p08_item_universe_ref:
      input.p09.p08_terminal_status === "cancelled" ? null : input.p09.p08_item_universe_ref,
    p01_obligation_ledger_ref: input.p09.p01_obligation_ledger_ref,
    ...(input.p09.coverage_input_ref === null
      ? {}
      : { p09_coverage_input_ref: input.p09.coverage_input_ref }),
    ...(input.p09.phase_evidence_refs.length === 0
      ? {}
      : { p09_phase_evidence_refs: [...input.p09.phase_evidence_refs] }),
    ...(input.p09.obligation_resolution_ref === null
      ? {}
      : { p09_obligation_resolution_ref: input.p09.obligation_resolution_ref }),
  };
  const request: StartRequest = {
    schema_version: 2,
    action: "start",
    identity: {
      schema_version: 2,
      run_id: input.p09.run_id,
      session_id: `session-${input.p09.run_id}`,
      playbook: SCA_P09_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript",
    },
    goal: "Produce the exact P09 result for the inactive P10 candidate.",
    constraints,
    project_root: PROJECT_ROOT,
    trust_profile: "hardened-untrusted",
    input_artifacts: {
      schema_version: 2,
      artifacts: [
        { slot: "p08_terminal", ref: input.p09.p08_terminal_ref },
        ...(input.p09.p08_terminal_status === "cancelled"
          ? []
          : [
              { slot: "p08_transition", ref: input.p09.p08_transition_ref },
              { slot: "p08_evidence_ledger", ref: input.p09.p08_evidence_ledger_ref },
              { slot: "p08_gate", ref: input.p09.p08_gate_ref },
              { slot: "p08_admission", ref: input.p09.p08_admission_ref },
              { slot: "p08_item_universe", ref: input.p09.p08_item_universe_ref },
            ]),
        { slot: "p01_obligation_ledger", ref: input.p09.p01_obligation_ledger_ref },
        ...(input.p09.coverage_input_ref === null
          ? []
          : [{ slot: "p09_coverage_input", ref: input.p09.coverage_input_ref }]),
        ...input.p09.phase_evidence_refs.map((ref, index) => ({
          slot: `p09_phase_evidence_${String(index).padStart(4, "0")}`,
          ref,
        })),
        ...(input.p09.obligation_resolution_ref === null
          ? []
          : [{ slot: "p09_obligation_resolution", ref: input.p09.obligation_resolution_ref }]),
      ],
    },
  };
  const prepared = startAdmission.prepare(request, {});
  const refs = startAdmission.materialize(prepared, {
    run_id: input.p09.run_id,
    artifactStore: input.store,
    trustedClock: () => new Date(clock),
  });
  const run = RunContext.create({
    identity: request.identity,
    goal: request.goal,
    constraints: {},
    projectRoot: PROJECT_ROOT,
    trustProfile: "hardened-untrusted",
    maxSteps: 8,
    initialArtifacts: refs,
  });
  const playbook = registration.construct({
    artifactStore: input.store,
    trustedClock: () => new Date(clock),
  });
  const directive: Directive = playbook.initialize(run);
  if (directive.action !== "incomplete" && directive.action !== "cancelled") {
    throw new Error("P09 did not reach a non-positive terminal");
  }
  const selected = run.selectedArtifacts;
  const byKind = (kind: string): ArtifactRef | null =>
    [...selected].reverse().find((ref) => ref.kind === kind) ?? null;
  const terminalRef = byKind("sca-p09-terminal");
  if (terminalRef === null) throw new Error("P09 terminal ref is absent");
  return {
    terminal_ref: terminalRef,
    transition_ref: byKind("sca-p09-to-p10-transition"),
    ledger_ref: byKind("sca-p09-reconciliation-ledger"),
    gate_ref: byKind("sca-p09-gate"),
    admission_ref: byKind("sca-p09-admission"),
  };
}
