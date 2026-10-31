import { canonicalJson, sha256 } from "../canonical-json.js";
import { type ArtifactRef } from "../contracts.js";
import {
  SCA_P12_RELEASE_APPROVAL_SCHEMA,
  validateScaP12ReleaseApprovalV1,
  validateScaP12ReleaseAuthorityV1,
  validateScaP12GateV1,
  type ScaP12GateV1,
  type ScaP12ReleaseApprovalV1,
  type ScaP12ReleaseAuthorityV1,
  type ScaP12VerifierAuthorityV1,
} from "./p12-contracts.js";
import { SCA_P12_GATE_PREDICATE_KEYS } from "./p12-release.js";

/** Derived approver separation, computed from the actual verifier / report-production / release identities. */
export interface ScaP12ApproverSeparationV1 {
  readonly separated_from_verifier: boolean;
  readonly separated_from_report_production: boolean;
  readonly distinct_from_release_authority: boolean;
}

/**
 * Derive the human approver's separation from the exact identities actually bound in the evidence —
 * never a hardcoded flag. The approver must differ from the verifier authority, from every P11
 * report-production identity/lineage, and from the automated release authority.
 */
export function deriveScaP12ApproverSeparation(input: {
  readonly human_principal_id: string;
  readonly verifier_authority: ScaP12VerifierAuthorityV1;
  readonly release_authority: ScaP12ReleaseAuthorityV1;
  readonly report_production_identity_ids: readonly string[];
  readonly report_production_lineage_ids: readonly string[];
}): ScaP12ApproverSeparationV1 {
  const principal = input.human_principal_id;
  const identityIds = new Set(input.report_production_identity_ids);
  const lineageIds = new Set(input.report_production_lineage_ids);
  const verifier = input.verifier_authority;
  const release = input.release_authority;
  return {
    separated_from_verifier:
      principal !== verifier.verifier_identity_id && principal !== verifier.verifier_lineage_id,
    separated_from_report_production: !identityIds.has(principal) && !lineageIds.has(principal),
    distinct_from_release_authority:
      principal !== release.release_authority_identity_id &&
      principal !== release.release_authority_lineage_id,
  };
}

/**
 * Seal the closed human release-approval contract (P12-R20/§8, ambiguity A4/A7). It binds the exact
 * release subject by ref+digest and records the derived approver-separation flags. The flags are
 * recomputed and re-checked at evaluation time; they are never trusted as authored.
 */
export function sealScaP12ReleaseApprovalV1(
  value: Omit<ScaP12ReleaseApprovalV1, "approval_sha256" | "schema_id" | "schema_version">
): ScaP12ReleaseApprovalV1 {
  const body = {
    schema_id: SCA_P12_RELEASE_APPROVAL_SCHEMA,
    schema_version: 1 as const,
    ...value,
  };
  return validateScaP12ReleaseApprovalV1({
    ...body,
    approval_sha256: sha256(canonicalJson(body)),
  });
}

export interface ScaP12ApprovalEvaluationV1 {
  readonly valid: boolean;
  readonly blocker_codes: readonly string[];
}

/**
 * Deterministic host evaluation of the exact-bound human release approval. It requires a `pass_ready`
 * gate whose every predicate is true, re-derives the approver separation from the actual identities,
 * and rejects any missing, expired, unauthorized, or digest-drifted binding (P12-R19/R21/§8).
 */
export function evaluateScaP12ReleaseApprovalV1(input: {
  readonly approval: ScaP12ReleaseApprovalV1;
  readonly gate: ScaP12GateV1;
  readonly verifier_authority: ScaP12VerifierAuthorityV1;
  readonly release_authority: ScaP12ReleaseAuthorityV1;
  readonly release_authority_ref: ArtifactRef;
  readonly report_production_identity_ids: readonly string[];
  readonly report_production_lineage_ids: readonly string[];
  readonly report_projection_ref: ArtifactRef;
  readonly gate_ref: ArtifactRef;
  readonly release_record_draft_sha256: string;
  readonly now: Date;
}): ScaP12ApprovalEvaluationV1 {
  const approval = validateScaP12ReleaseApprovalV1(input.approval);
  const authority = validateScaP12ReleaseAuthorityV1(input.release_authority);
  const gate = validateScaP12GateV1(input.gate);
  const blockers: string[] = [];

  if (
    gate.verdict !== "pass_ready" ||
    gate.blocker_codes.length !== 0 ||
    gate.report_ref === null ||
    SCA_P12_GATE_PREDICATE_KEYS.some((key) => gate[key] !== true)
  ) {
    blockers.push("p12_release_approval_gate_not_pass_ready");
  }

  if (approval.decision !== "approved") blockers.push("p12_release_approval_rejected");
  if (!same(approval.report_projection_ref, input.report_projection_ref)) {
    blockers.push("p12_release_approval_report_projection_drifted");
  }
  if (
    approval.report_projection_sha256 !== input.report_projection_ref.content_digest ||
    approval.gate_sha256 !== input.gate_ref.content_digest ||
    !same(approval.gate_ref, input.gate_ref)
  ) {
    blockers.push("p12_release_approval_gate_drifted");
  }
  if (approval.release_record_draft_sha256 !== input.release_record_draft_sha256) {
    blockers.push("p12_release_approval_release_record_draft_drifted");
  }
  if (!same(approval.release_authority_ref, input.release_authority_ref)) {
    blockers.push("p12_release_approval_authority_binding_invalid");
  }
  if (authority.decision !== "authorized") blockers.push("p12_release_authority_not_authorized");
  if (authority.publication_authority !== "separate_unmet") {
    blockers.push("p12_publication_authority_misclaimed");
  }

  const derived = deriveScaP12ApproverSeparation({
    human_principal_id: approval.human_principal_id,
    verifier_authority: input.verifier_authority,
    release_authority: input.release_authority,
    report_production_identity_ids: input.report_production_identity_ids,
    report_production_lineage_ids: input.report_production_lineage_ids,
  });
  if (!derived.separated_from_verifier)
    blockers.push("p12_release_approver_not_separated_from_verifier");
  if (!derived.separated_from_report_production) {
    blockers.push("p12_release_approver_not_separated_from_report_production");
  }
  if (!derived.distinct_from_release_authority) {
    blockers.push("p12_release_approver_not_distinct_from_release_authority");
  }
  if (
    approval.separated_from_verifier !== derived.separated_from_verifier ||
    approval.separated_from_report_production !== derived.separated_from_report_production ||
    approval.distinct_from_release_authority !== derived.distinct_from_release_authority
  ) {
    blockers.push("p12_release_approver_separation_flag_mismatch");
  }

  const nowMs = input.now.getTime();
  if (
    !Number.isFinite(nowMs) ||
    nowMs > Date.parse(approval.expires_at) ||
    nowMs < Date.parse(approval.decided_at)
  ) {
    blockers.push("p12_release_approval_expired_or_not_yet_valid");
  }
  return {
    valid: blockers.length === 0,
    blocker_codes: [...new Set(blockers)].sort(),
  };
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
