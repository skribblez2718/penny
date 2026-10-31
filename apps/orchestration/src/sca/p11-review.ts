import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import { redactScaP11Sensitive, scanScaP11Sensitive } from "./p11-redaction.js";
import {
  SCA_P11_ADDENDUM_SCHEMA,
  SCA_P11_COGNITIVE_PAYLOAD_SCHEMA,
  SCA_P11_DISCLOSURE_ADMISSION_SCHEMA,
  SCA_P11_REPAIR_CALL_ID,
  SCA_P11_REPAIR_PURPOSE,
  SCA_P11_REPAIR_RECORD_SCHEMA,
  SCA_P11_REQUIRED_MODEL,
  SCA_P11_REVIEW_CALL_ID,
  SCA_P11_REVIEW_PURPOSE,
  SCA_P11_REVIEWER_ROLE,
  validateScaP11AddendumV1,
  validateScaP11CognitivePayloadV1,
  validateScaP11DisclosureAdmissionV1,
  validateScaP11RepairRecordV1,
  withP11Digest,
  type ScaP11AddendumKindV1,
  type ScaP11AddendumV1,
  type ScaP11CognitivePayloadV1,
  type ScaP11DisclosureAdmissionV1,
  type ScaP11DisclosureScopeV1,
  type ScaP11OpenItemDispositionV1,
  type ScaP11RepairRecordV1,
  type ScaP11ReportJsonV1,
  type ScaP11SemanticReviewV1,
} from "./p11-contracts.js";

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function scaP11AssertionId(input: {
  readonly target_kind: "finding" | "report" | "open_item";
  readonly target_id: string;
  readonly claim: string;
}): string {
  return `p11asrt_${sha256(canonicalJson(input))}`;
}

export interface ScaP11AssertionV1 {
  readonly assertion_id: string;
  readonly target_kind: "finding" | "report" | "open_item";
  readonly target_id: string;
  readonly claim: string;
  readonly evidence_allowlist: readonly ArtifactRef[];
  readonly source_pointer: string | null;
}

/**
 * Deterministic extraction of the substantive assertions the semantic reviewer must resolve. Every
 * finding's severity/status/CWE/threat claims and every report-level statement become one assertion;
 * a heading or a keyword is never treated as proof. Each assertion carries the host-assigned evidence
 * allowlist the reviewer may cite for it: a finding assertion is grounded in the finding's exact
 * evidence/source refs, and a report-level assertion in the reconciled record universe.
 */
export function scaP11ReviewAssertions(input: {
  readonly report: ScaP11ReportJsonV1;
  readonly reconciliation_ref: ArtifactRef;
}): readonly ScaP11AssertionV1[] {
  const report = input.report;
  const assertions: ScaP11AssertionV1[] = [];
  const push = (
    target_kind: "finding" | "report" | "open_item",
    target_id: string,
    claim: string,
    evidence_allowlist: readonly ArtifactRef[],
    source_pointer: string | null
  ): void => {
    assertions.push({
      assertion_id: scaP11AssertionId({ target_kind, target_id, claim }),
      target_kind,
      target_id,
      claim,
      evidence_allowlist: [...evidence_allowlist],
      source_pointer,
    });
  };
  const reportAllowlist = [input.reconciliation_ref];
  push("report", "sca-p11-report", report.scope_statement, reportAllowlist, null);
  push("report", "sca-p11-report", report.coverage_statement, reportAllowlist, null);
  push("report", "sca-p11-report", report.rule_learning_statement, reportAllowlist, null);
  push("report", "sca-p11-report", report.executive_summary, reportAllowlist, null);
  for (const finding of report.findings) {
    const evidence = [
      ...new Set([...finding.evidence_refs, ...finding.source_refs].map((ref) => ref)),
    ]
      .filter(
        (ref, index, all) =>
          all.findIndex((other) => other.artifact_id === ref.artifact_id) === index
      )
      .sort((left, right) => (left.artifact_id < right.artifact_id ? -1 : 1));
    push(
      "finding",
      finding.finding_id,
      `severity=${finding.severity_token} exception=${finding.exception_shape} status=${finding.status ?? "none"}`,
      evidence,
      null
    );
    push("finding", finding.finding_id, finding.description, evidence, null);
    push("finding", finding.finding_id, finding.remediation, evidence, null);
    if (finding.cwe_id !== null && finding.cwe_name !== null) {
      push(
        "finding",
        finding.finding_id,
        `CWE=${finding.cwe_id} ${finding.cwe_name}`,
        evidence,
        null
      );
    }
    if (finding.threat_model_id !== null) {
      push(
        "finding",
        finding.finding_id,
        `threat_model=${finding.threat_model_id}`,
        evidence,
        null
      );
    }
  }
  return assertions.sort((left, right) =>
    left.assertion_id < right.assertion_id ? -1 : left.assertion_id > right.assertion_id ? 1 : 0
  );
}

export interface ScaP11SemanticFailureV1 {
  readonly assertion_id: string;
  readonly code: string;
  readonly detail: string;
}

export interface ScaP11SemanticOpenItemV1 {
  readonly open_item_id: string;
  readonly target_id: string;
  readonly severity: "blocking" | "actionable";
  readonly disposition: ScaP11OpenItemDispositionV1;
  readonly evidence_refs: readonly ArtifactRef[];
}

export interface ScaP11SemanticEvaluationV1 {
  readonly passed: boolean;
  readonly open_items: readonly ScaP11SemanticOpenItemV1[];
  readonly failures: readonly ScaP11SemanticFailureV1[];
}

/**
 * Deterministically evaluate a semantic review against the host-assigned payload. The review passes
 * only when **every** assigned assertion is resolved exactly once, its verdict is `supported`, it
 * cites at least one exact evidence ref drawn from that assertion's host-assigned allowlist, and
 * every cited ref is exact-readable in the host store. `insufficient`, `refuted`, a missing verdict,
 * or empty/foreign/unreadable evidence creates a blocking open item and blocks `pass_ready`; model
 * agreement, headings, and keywords are never proof (`AC-P11` #5, `P11-R13`).
 */
export function evaluateScaP11SemanticReview(input: {
  readonly payload: ScaP11CognitivePayloadV1;
  readonly review: ScaP11SemanticReviewV1;
  readonly exactReadable: (ref: ArtifactRef) => boolean;
}): ScaP11SemanticEvaluationV1 {
  const failures: ScaP11SemanticFailureV1[] = [];
  const openItems: ScaP11SemanticOpenItemV1[] = [];
  const assertionById = new Map(
    input.payload.assertions.map((entry) => [entry.assertion_id, entry])
  );
  const verdictById = new Map(input.review.verdicts.map((entry) => [entry.assertion_id, entry]));
  const assigned = new Set(input.payload.assigned_assertion_ids);

  const fail = (assertion: ScaP11AssertionV1, code: string, detail: string): void => {
    failures.push({ assertion_id: assertion.assertion_id, code, detail });
    openItems.push({
      open_item_id: `p11openitem_${sha256(canonicalJson({ assertion_id: assertion.assertion_id, code }))}`,
      target_id: assertion.target_id,
      severity: "blocking",
      disposition: "retained-incomplete",
      evidence_refs: [],
    });
  };

  for (const id of input.payload.assigned_assertion_ids) {
    const assertion = assertionById.get(id);
    if (assertion === undefined) {
      failures.push({
        assertion_id: id,
        code: "payload_assertion_missing",
        detail: "the payload assigned an assertion it does not carry",
      });
      continue;
    }
    const verdict = verdictById.get(id);
    if (verdict === undefined) {
      fail(assertion, "assertion_unresolved", "no verdict was returned for this assertion");
      continue;
    }
    if (verdict.target_id !== assertion.target_id) {
      fail(assertion, "assertion_target_mismatch", "the verdict names a different target");
      continue;
    }
    if (verdict.verdict === "refuted") {
      fail(assertion, "assertion_refuted", "the reviewer refuted the assertion");
      continue;
    }
    if (verdict.verdict === "insufficient") {
      fail(assertion, "assertion_insufficient", "the reviewer could not resolve the assertion");
      continue;
    }
    if (verdict.evidence_refs.length === 0) {
      fail(assertion, "assertion_evidence_empty", "a supported verdict cited no exact evidence");
      continue;
    }
    const allowlist = new Map(assertion.evidence_allowlist.map((ref) => [ref.artifact_id, ref]));
    let code: string | null = null;
    for (const ref of verdict.evidence_refs) {
      const allowed = allowlist.get(ref.artifact_id);
      if (allowed === undefined || !same(allowed, ref)) {
        code = "assertion_evidence_foreign";
        break;
      }
      if (!input.exactReadable(ref)) {
        code = "assertion_evidence_unreadable";
        break;
      }
    }
    if (code !== null) {
      fail(
        assertion,
        code,
        "a cited evidence ref is outside the host-assigned allowlist or unreadable"
      );
      continue;
    }
  }

  for (const verdict of input.review.verdicts) {
    if (!assigned.has(verdict.assertion_id)) {
      failures.push({
        assertion_id: verdict.assertion_id,
        code: "verdict_foreign_assertion",
        detail: "the review returned a verdict the host never assigned",
      });
    }
  }

  const reviewerBlocking = input.review.open_items.some((item) => item.severity === "blocking");
  return {
    passed: failures.length === 0 && !reviewerBlocking,
    open_items: openItems,
    failures,
  };
}

export interface ScaP11PayloadBuildInputV1 {
  readonly run_id: string;
  readonly revision: number;
  readonly report_ref: ArtifactRef;
  readonly report: ScaP11ReportJsonV1;
  readonly reconciliation_ref: ArtifactRef;
  readonly scoring_records_ref: ArtifactRef | null;
  readonly disclosure_scope_ref: ArtifactRef;
  readonly repair_violations: readonly string[];
}

export function buildScaP11CognitivePayloadV1(input: ScaP11PayloadBuildInputV1): {
  readonly payload: ScaP11CognitivePayloadV1;
  readonly assertions: readonly ScaP11AssertionV1[];
} {
  const assertions = scaP11ReviewAssertions({
    report: input.report,
    reconciliation_ref: input.reconciliation_ref,
  });
  const isRepair = input.repair_violations.length > 0;
  const payload = validateScaP11CognitivePayloadV1(
    withP11Digest(
      {
        schema_id: SCA_P11_COGNITIVE_PAYLOAD_SCHEMA,
        schema_version: 1 as const,
        run_id: input.run_id,
        phase_id: "SCA-P11" as const,
        call_id: isRepair ? SCA_P11_REPAIR_CALL_ID : SCA_P11_REVIEW_CALL_ID,
        role: SCA_P11_REVIEWER_ROLE,
        purpose: isRepair ? SCA_P11_REPAIR_PURPOSE : SCA_P11_REVIEW_PURPOSE,
        required_model: SCA_P11_REQUIRED_MODEL,
        revision: input.revision,
        report_ref: input.report_ref,
        reconciliation_ref: input.reconciliation_ref,
        scoring_records_ref: input.scoring_records_ref,
        disclosure_scope_ref: input.disclosure_scope_ref,
        repair_violations: input.repair_violations.map((violation) =>
          redactScaP11Sensitive(violation)
        ),
        assigned_assertion_ids: assertions.map((assertion) => assertion.assertion_id),
        assertions: assertions.map((assertion) => ({
          assertion_id: assertion.assertion_id,
          target_kind: assertion.target_kind,
          target_id: assertion.target_id,
          claim: redactScaP11Sensitive(assertion.claim),
          evidence_allowlist: [...assertion.evidence_allowlist],
          source_pointer:
            assertion.source_pointer === null
              ? null
              : redactScaP11Sensitive(assertion.source_pointer),
        })),
      },
      "payload_sha256"
    )
  );
  return { payload, assertions };
}

export function buildScaP11DisclosureAdmissionV1(input: {
  readonly run_id: string;
  readonly call_id: typeof SCA_P11_REVIEW_CALL_ID | typeof SCA_P11_REPAIR_CALL_ID;
  readonly scope: ScaP11DisclosureScopeV1;
  readonly scope_ref: ArtifactRef;
  readonly payload_ref: ArtifactRef;
  readonly payload: ScaP11CognitivePayloadV1;
  readonly authorized_refs: readonly ArtifactRef[];
}): ScaP11DisclosureAdmissionV1 {
  const purpose =
    input.call_id === SCA_P11_REPAIR_CALL_ID ? SCA_P11_REPAIR_PURPOSE : SCA_P11_REVIEW_PURPOSE;
  const withinLimit = input.payload_ref.byte_length <= input.scope.max_payload_bytes_per_call;
  // Truthfully scan the exact serialized payload the host is about to disclose. Redaction runs
  // before dispatch, so a well-formed payload carries no secret or personal-data span; a residual
  // span denies the call and is recorded rather than reproduced (`SCA-C08`, `P11-R16`).
  const sensitive = scanScaP11Sensitive(canonicalJson(input.payload));
  const purposeMismatch = input.scope.purpose !== purpose;
  const blocked =
    input.scope.decision !== "allow" ||
    input.scope.run_id !== input.run_id ||
    !same(input.scope.required_model, SCA_P11_REQUIRED_MODEL) ||
    !withinLimit ||
    sensitive.secrets ||
    sensitive.personal_data ||
    purposeMismatch;
  const blockerCodes: string[] = [];
  if (input.scope.decision !== "allow") blockerCodes.push("p11_disclosure_scope_denied");
  if (input.scope.run_id !== input.run_id) blockerCodes.push("p11_disclosure_scope_run_mismatch");
  if (!same(input.scope.required_model, SCA_P11_REQUIRED_MODEL))
    blockerCodes.push("p11_disclosure_scope_model_mismatch");
  if (!withinLimit) blockerCodes.push("p11_payload_limit_exceeded");
  if (sensitive.secrets) blockerCodes.push("p11_payload_secret_present");
  if (sensitive.personal_data) blockerCodes.push("p11_payload_personal_data_present");
  if (purposeMismatch) blockerCodes.push("p11_disclosure_scope_purpose_mismatch");
  return validateScaP11DisclosureAdmissionV1(
    withP11Digest(
      {
        schema_id: SCA_P11_DISCLOSURE_ADMISSION_SCHEMA,
        schema_version: 1 as const,
        run_id: input.run_id,
        phase_id: "SCA-P11" as const,
        call_id: input.call_id,
        role: SCA_P11_REVIEWER_ROLE,
        purpose,
        required_model: SCA_P11_REQUIRED_MODEL,
        disclosure_scope_ref: input.scope_ref,
        disclosure_scope_sha256: input.scope.scope_sha256,
        payload_ref: input.payload_ref,
        payload_sha256: input.payload_ref.content_digest,
        payload_byte_length: input.payload_ref.byte_length,
        serialized_opening_byte_limit: input.scope.max_payload_bytes_per_call,
        authorized_refs: [...input.authorized_refs],
        destination: "cloud" as const,
        retention_days: input.scope.provider_retention_days,
        logging_status: input.scope.provider_logging_status,
        logging_days: input.scope.provider_logging_days,
        training: "prohibited" as const,
        secrets_embedded: sensitive.secrets,
        personal_data_embedded: sensitive.personal_data,
        decision: blocked ? ("deny" as const) : ("allow" as const),
        blocker_codes: [...new Set(blockerCodes)].sort(),
        evaluated_before_dispatch: true as const,
      },
      "admission_sha256"
    )
  );
}

export function buildScaP11RepairRecordV1(input: {
  readonly run_id: string;
  readonly base_report_ref: ArtifactRef;
  readonly base_revision: number;
  readonly revision: number;
  readonly operations: ScaP11RepairRecordV1["ordered_operations"];
  readonly violations_addressed: readonly string[];
  readonly repairer_identity_id: string;
  readonly repairer_lineage_id: string;
  readonly deterministic_validation_ref: ArtifactRef;
  readonly deterministic_validation_passed: boolean;
  readonly semantic_review_ref: ArtifactRef;
  readonly semantic_review_passed: boolean;
}): ScaP11RepairRecordV1 {
  return validateScaP11RepairRecordV1(
    withP11Digest(
      {
        schema_id: SCA_P11_REPAIR_RECORD_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P11" as const,
        run_id: input.run_id,
        base_report_ref: input.base_report_ref,
        base_report_sha256: input.base_report_ref.content_digest,
        base_revision: input.base_revision,
        revision: input.revision,
        repairer_identity_id: input.repairer_identity_id,
        repairer_lineage_id: input.repairer_lineage_id,
        ordered_operations: [...input.operations],
        violations_addressed: [...input.violations_addressed],
        reentry: {
          deterministic_validation_ref: input.deterministic_validation_ref,
          deterministic_validation_passed: input.deterministic_validation_passed,
          semantic_review_ref: input.semantic_review_ref,
          semantic_review_passed: input.semantic_review_passed,
        },
        deleted_finding_ids: [],
      },
      "repair_sha256"
    )
  );
}

export function buildScaP11AddendumV1(input: {
  readonly run_id: string;
  readonly base_report_ref: ArtifactRef;
  readonly addendum_kind: ScaP11AddendumKindV1;
  readonly subject_refs: readonly ArtifactRef[];
  readonly rationale: string;
}): ScaP11AddendumV1 {
  return validateScaP11AddendumV1(
    withP11Digest(
      {
        schema_id: SCA_P11_ADDENDUM_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P11" as const,
        run_id: input.run_id,
        base_report_ref: input.base_report_ref,
        base_report_digest: input.base_report_ref.content_digest,
        addendum_kind: input.addendum_kind,
        subject_refs: [...input.subject_refs],
        rationale: input.rationale,
        completes_report: false as const,
        mutates_report: false as const,
        append_only: true as const,
        invalidates_release_approval: true as const,
      },
      "addendum_sha256"
    )
  );
}
