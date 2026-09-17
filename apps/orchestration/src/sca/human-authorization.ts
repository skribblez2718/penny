import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract } from "../contracts.js";
import { OpaqueIdSchema, Rfc3339UtcSchema, Sha256Schema } from "../skill-contracts/common.js";

const MAX_TEXT = 8_192;
const MAX_CAPABILITIES = 64;

export const SCA_STRONGER_EXECUTION_PROPOSAL_SCHEMA = "penny.sca-stronger-execution-proposal.v1";
export const SCA_HUMAN_AUTHORIZATION_DECISION_SCHEMA = "penny.sca-human-authorization-decision.v1";
export const SCA_STRONGER_EXECUTION_REQUEST_SCHEMA = "penny.sca-stronger-execution-request.v1";

const ScaStrongerActionTypeV1Schema = Type.Union([
  Type.Literal("build"),
  Type.Literal("test"),
  Type.Literal("harness"),
  Type.Literal("proof_of_concept"),
]);

const CapabilitySchema = Type.String({ minLength: 1, maxLength: 512 });

export const ScaStrongerExecutionProposalInputV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_STRONGER_EXECUTION_PROPOSAL_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    m2_manifest_sha256: Sha256Schema,
    proposal_id: OpaqueIdSchema,
    action_type: ScaStrongerActionTypeV1Schema,
    action_plan_sha256: Sha256Schema,
    requested_capabilities: Type.Array(CapabilitySchema, {
      minItems: 1,
      maxItems: MAX_CAPABILITIES,
    }),
    justification: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    expected_discriminator: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    expires_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);

export const ScaStrongerExecutionProposalV1Schema = Type.Object(
  {
    ...ScaStrongerExecutionProposalInputV1Schema.properties,
    proposal_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const ScaHumanAuthorizationDecisionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_HUMAN_AUTHORIZATION_DECISION_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    m2_manifest_sha256: Sha256Schema,
    proposal_id: OpaqueIdSchema,
    proposal_sha256: Sha256Schema,
    decision: Type.Union([
      Type.Literal("approved"),
      Type.Literal("denied"),
      Type.Literal("expired"),
      Type.Literal("drifted"),
    ]),
    human_principal_id: OpaqueIdSchema,
    authority_receipt_sha256: Sha256Schema,
    decided_at: Rfc3339UtcSchema,
    expires_at: Rfc3339UtcSchema,
    decision_reason: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    decision_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const ScaStrongerExecutionRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_STRONGER_EXECUTION_REQUEST_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    m2_manifest_sha256: Sha256Schema,
    proposal_id: OpaqueIdSchema,
    action_type: ScaStrongerActionTypeV1Schema,
    action_plan_sha256: Sha256Schema,
    requested_capabilities: Type.Array(CapabilitySchema, {
      minItems: 1,
      maxItems: MAX_CAPABILITIES,
    }),
  },
  { additionalProperties: false }
);

const ScaStrongerExecutionAuthorizationV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-stronger-execution-authorization.v1"),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    m2_manifest_sha256: Sha256Schema,
    proposal_id: OpaqueIdSchema,
    proposal_sha256: Sha256Schema,
    decision_sha256: Sha256Schema,
    action_type: ScaStrongerActionTypeV1Schema,
    action_plan_sha256: Sha256Schema,
    authorized_capabilities: Type.Array(CapabilitySchema, {
      minItems: 1,
      maxItems: MAX_CAPABILITIES,
    }),
    human_principal_id: OpaqueIdSchema,
    authority_receipt_sha256: Sha256Schema,
    expires_at: Rfc3339UtcSchema,
    authorization_id: Type.String({ pattern: "^scaauth_[a-f0-9]{64}$" }),
    authorization_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export type ScaStrongerExecutionProposalInputV1 = Static<
  typeof ScaStrongerExecutionProposalInputV1Schema
>;
export type ScaStrongerExecutionProposalV1 = Static<typeof ScaStrongerExecutionProposalV1Schema>;
export type ScaHumanAuthorizationDecisionV1 = Static<typeof ScaHumanAuthorizationDecisionV1Schema>;
export type ScaStrongerExecutionRequestV1 = Static<typeof ScaStrongerExecutionRequestV1Schema>;
export type ScaStrongerExecutionAuthorizationV1 = Static<
  typeof ScaStrongerExecutionAuthorizationV1Schema
>;

type UnsignedProposal = Omit<ScaStrongerExecutionProposalV1, "proposal_sha256">;
type UnsignedDecision = Omit<ScaHumanAuthorizationDecisionV1, "decision_sha256">;
type UnsignedAuthorization = Omit<ScaStrongerExecutionAuthorizationV1, "authorization_sha256">;

export class ScaHumanAuthorizationError extends Error {
  constructor(
    readonly code:
      | "invalid_proposal"
      | "proposal_digest_mismatch"
      | "capability_collision"
      | "invalid_decision"
      | "decision_digest_mismatch"
      | "not_approved"
      | "expired"
      | "binding_mismatch"
      | "request_mismatch",
    message: string
  ) {
    super(message);
    this.name = "ScaHumanAuthorizationError";
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function uniqueSortedCapabilities(values: readonly string[]): string[] {
  if (new Set(values).size !== values.length) {
    throw new ScaHumanAuthorizationError(
      "capability_collision",
      "SCA stronger-execution capabilities must be unique"
    );
  }
  return [...values].sort(compareUtf8);
}

function proposalDigest(value: UnsignedProposal): string {
  return sha256(canonicalJson(value));
}

function decisionDigest(value: UnsignedDecision): string {
  return sha256(canonicalJson(value));
}

function authorizationDigest(value: UnsignedAuthorization): string {
  return sha256(canonicalJson(value));
}

export function buildScaStrongerExecutionProposalV1(
  value: unknown
): ScaStrongerExecutionProposalV1 {
  let input: ScaStrongerExecutionProposalInputV1;
  try {
    input = validateContract(
      ScaStrongerExecutionProposalInputV1Schema,
      value,
      "SCA stronger-execution proposal input"
    );
  } catch (error) {
    throw new ScaHumanAuthorizationError(
      "invalid_proposal",
      error instanceof Error ? error.message : "SCA stronger-execution proposal is invalid"
    );
  }
  const unsigned: UnsignedProposal = {
    ...input,
    requested_capabilities: uniqueSortedCapabilities(input.requested_capabilities),
  };
  const expiry = Date.parse(unsigned.expires_at);
  if (!Number.isFinite(expiry)) {
    throw new ScaHumanAuthorizationError("invalid_proposal", "proposal expiry is invalid");
  }
  return validateContract(
    ScaStrongerExecutionProposalV1Schema,
    { ...unsigned, proposal_sha256: proposalDigest(unsigned) },
    "SCA stronger-execution proposal"
  );
}

export function validateScaStrongerExecutionProposalV1(
  value: unknown
): ScaStrongerExecutionProposalV1 {
  const proposal = validateContract(
    ScaStrongerExecutionProposalV1Schema,
    value,
    "SCA stronger-execution proposal"
  );
  const { proposal_sha256: observedDigest, ...unsigned } = proposal;
  if (proposalDigest(unsigned) !== observedDigest) {
    throw new ScaHumanAuthorizationError(
      "proposal_digest_mismatch",
      "SCA stronger-execution proposal digest mismatch"
    );
  }
  return proposal;
}

export function sealScaHumanAuthorizationDecisionV1(
  value: Omit<ScaHumanAuthorizationDecisionV1, "decision_sha256">
): ScaHumanAuthorizationDecisionV1 {
  let unsigned: UnsignedDecision;
  try {
    unsigned = validateContract(
      Type.Omit(ScaHumanAuthorizationDecisionV1Schema, ["decision_sha256"]),
      value,
      "SCA human authorization decision input"
    );
  } catch (error) {
    throw new ScaHumanAuthorizationError(
      "invalid_decision",
      error instanceof Error ? error.message : "SCA human authorization decision is invalid"
    );
  }
  if (
    !Number.isFinite(Date.parse(unsigned.decided_at)) ||
    !Number.isFinite(Date.parse(unsigned.expires_at)) ||
    Date.parse(unsigned.expires_at) < Date.parse(unsigned.decided_at)
  ) {
    throw new ScaHumanAuthorizationError(
      "invalid_decision",
      "SCA human authorization decision time range is invalid"
    );
  }
  return validateContract(
    ScaHumanAuthorizationDecisionV1Schema,
    { ...unsigned, decision_sha256: decisionDigest(unsigned) },
    "SCA human authorization decision"
  );
}

export function validateScaHumanAuthorizationDecisionV1(
  value: unknown
): ScaHumanAuthorizationDecisionV1 {
  const decision = validateContract(
    ScaHumanAuthorizationDecisionV1Schema,
    value,
    "SCA human authorization decision"
  );
  const { decision_sha256: observedDigest, ...unsigned } = decision;
  if (decisionDigest(unsigned) !== observedDigest) {
    throw new ScaHumanAuthorizationError(
      "decision_digest_mismatch",
      "SCA human authorization decision digest mismatch"
    );
  }
  return decision;
}

function exactBinding(
  proposal: ScaStrongerExecutionProposalV1,
  decision: ScaHumanAuthorizationDecisionV1,
  request: ScaStrongerExecutionRequestV1
): boolean {
  return (
    proposal.tenant_id === decision.tenant_id &&
    proposal.tenant_id === request.tenant_id &&
    proposal.project_id === decision.project_id &&
    proposal.project_id === request.project_id &&
    proposal.run_id === decision.run_id &&
    proposal.run_id === request.run_id &&
    proposal.source_snapshot_sha256 === decision.source_snapshot_sha256 &&
    proposal.source_snapshot_sha256 === request.source_snapshot_sha256 &&
    proposal.m2_manifest_sha256 === decision.m2_manifest_sha256 &&
    proposal.m2_manifest_sha256 === request.m2_manifest_sha256 &&
    proposal.proposal_id === decision.proposal_id &&
    proposal.proposal_id === request.proposal_id &&
    proposal.proposal_sha256 === decision.proposal_sha256
  );
}

export function admitScaStrongerExecutionV1(
  proposalValue: unknown,
  decisionValue: unknown,
  requestValue: unknown,
  now: Date = new Date()
): ScaStrongerExecutionAuthorizationV1 {
  const proposal = validateScaStrongerExecutionProposalV1(proposalValue);
  const decision = validateScaHumanAuthorizationDecisionV1(decisionValue);
  const request = validateContract(
    ScaStrongerExecutionRequestV1Schema,
    requestValue,
    "SCA stronger-execution request"
  );
  if (!exactBinding(proposal, decision, request)) {
    throw new ScaHumanAuthorizationError(
      "binding_mismatch",
      "SCA stronger-execution proposal, decision, and request bindings differ"
    );
  }
  if (decision.decision !== "approved") {
    throw new ScaHumanAuthorizationError(
      "not_approved",
      "SCA stronger execution requires an approved human decision"
    );
  }
  const nowMs = now.getTime();
  if (
    !Number.isFinite(nowMs) ||
    nowMs > Date.parse(proposal.expires_at) ||
    nowMs > Date.parse(decision.expires_at)
  ) {
    throw new ScaHumanAuthorizationError(
      "expired",
      "SCA stronger-execution authorization has expired"
    );
  }
  const requestedCapabilities = uniqueSortedCapabilities(request.requested_capabilities);
  if (
    request.action_type !== proposal.action_type ||
    request.action_plan_sha256 !== proposal.action_plan_sha256 ||
    canonicalJson(requestedCapabilities) !== canonicalJson(proposal.requested_capabilities)
  ) {
    throw new ScaHumanAuthorizationError(
      "request_mismatch",
      "SCA stronger-execution request differs from the approved proposal"
    );
  }
  const authorizationId = `scaauth_${sha256(
    canonicalJson({
      proposal_sha256: proposal.proposal_sha256,
      decision_sha256: decision.decision_sha256,
    })
  )}`;
  const unsigned: UnsignedAuthorization = {
    schema_id: "penny.sca-stronger-execution-authorization.v1",
    schema_version: 1,
    tenant_id: proposal.tenant_id,
    project_id: proposal.project_id,
    run_id: proposal.run_id,
    source_snapshot_sha256: proposal.source_snapshot_sha256,
    m2_manifest_sha256: proposal.m2_manifest_sha256,
    proposal_id: proposal.proposal_id,
    proposal_sha256: proposal.proposal_sha256,
    decision_sha256: decision.decision_sha256,
    action_type: proposal.action_type,
    action_plan_sha256: proposal.action_plan_sha256,
    authorized_capabilities: requestedCapabilities,
    human_principal_id: decision.human_principal_id,
    authority_receipt_sha256: decision.authority_receipt_sha256,
    expires_at:
      Date.parse(proposal.expires_at) <= Date.parse(decision.expires_at)
        ? proposal.expires_at
        : decision.expires_at,
    authorization_id: authorizationId,
  };
  return validateContract(
    ScaStrongerExecutionAuthorizationV1Schema,
    { ...unsigned, authorization_sha256: authorizationDigest(unsigned) },
    "SCA stronger-execution authorization"
  );
}
