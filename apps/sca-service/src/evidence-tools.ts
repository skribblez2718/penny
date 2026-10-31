import { Type, type Static } from "typebox";

import { validateContract } from "../../orchestration/dist/contracts.js";
import {
  sealScaFindingEvidenceV1,
  type ScaFindingEvidenceV1,
} from "../../orchestration/dist/sca/stronger-evidence.js";
import {
  ScaStrongerExecutionAuthorizationV1Schema,
  validateScaStrongerExecutionAuthorizationV1,
} from "../../orchestration/dist/sca/human-authorization.js";
import { OpaqueIdSchema, Sha256Schema } from "../../orchestration/dist/skill-contracts/common.js";
import {
  ScaEvidenceExecutionReceiptV1Schema,
  validateScaEvidenceExecutionReceiptV1,
} from "./sandbox-runtime.js";

const MAX_ITEMS = 100_000;
const MAX_TEXT = 8_192;

export const SCA_EVIDENCE_ATTACHMENT_REQUEST_SCHEMA = "penny.sca-evidence-attachment-request.v1";

export const ScaEvidenceAttachmentRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_EVIDENCE_ATTACHMENT_REQUEST_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    finding_set_sha256: Sha256Schema,
    m3_manifest_sha256: Sha256Schema,
    authorization: ScaStrongerExecutionAuthorizationV1Schema,
    execution_receipt: ScaEvidenceExecutionReceiptV1Schema,
    finding_ids: Type.Array(Type.String({ pattern: "^scafind_[a-f0-9]{64}$" }), {
      maxItems: MAX_ITEMS,
    }),
    gap_ids: Type.Array(Type.String({ pattern: "^scagap_[a-f0-9]{64}$" }), {
      maxItems: MAX_ITEMS,
    }),
    effect: Type.Union([
      Type.Literal("supports_finding"),
      Type.Literal("refutes_finding"),
      Type.Literal("resolves_gap"),
      Type.Literal("inconclusive"),
    ]),
    summary: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
  },
  { additionalProperties: false }
);

export type ScaEvidenceAttachmentRequestV1 = Static<typeof ScaEvidenceAttachmentRequestV1Schema>;

export class ScaEvidenceToolError extends Error {
  constructor(
    readonly code: "invalid_attachment" | "binding_mismatch",
    message: string
  ) {
    super(message);
    this.name = "ScaEvidenceToolError";
  }
}

export function attachScaExecutionEvidenceV1(value: unknown): ScaFindingEvidenceV1 {
  let request: ScaEvidenceAttachmentRequestV1;
  try {
    request = validateContract(
      ScaEvidenceAttachmentRequestV1Schema,
      value,
      "SCA evidence attachment request"
    );
  } catch (error) {
    throw new ScaEvidenceToolError(
      "invalid_attachment",
      error instanceof Error ? error.message : "SCA evidence attachment request is invalid"
    );
  }
  const authorization = validateScaStrongerExecutionAuthorizationV1(request.authorization);
  const receipt = validateScaEvidenceExecutionReceiptV1(request.execution_receipt);
  if (
    receipt.run_id !== authorization.run_id ||
    receipt.source_snapshot_sha256 !== authorization.source_snapshot_sha256 ||
    receipt.authorization_id !== authorization.authorization_id ||
    receipt.action_type !== authorization.action_type ||
    receipt.action_plan_sha256 !== authorization.action_plan_sha256
  ) {
    throw new ScaEvidenceToolError(
      "binding_mismatch",
      "SCA authorization and execution receipt bindings differ"
    );
  }
  return sealScaFindingEvidenceV1({
    schema_id: "penny.sca-finding-evidence.v1",
    schema_version: 1,
    tenant_id: request.tenant_id,
    project_id: request.project_id,
    run_id: authorization.run_id,
    source_snapshot_sha256: authorization.source_snapshot_sha256,
    finding_set_sha256: request.finding_set_sha256,
    m3_manifest_sha256: request.m3_manifest_sha256,
    execution_id: receipt.execution_id,
    execution_receipt_sha256: receipt.evidence_sha256,
    authorization_id: authorization.authorization_id,
    authorization_sha256: authorization.authorization_sha256,
    human_principal_id: authorization.human_principal_id,
    sandbox_profile_sha256: receipt.sandbox_profile_sha256,
    action_plan_sha256: receipt.action_plan_sha256,
    action_type: receipt.action_type,
    execution_status: receipt.status,
    started_at: receipt.started_at,
    completed_at: receipt.completed_at,
    exit_code: receipt.exit_code,
    stdout_sha256: receipt.stdout_sha256,
    stderr_sha256: receipt.stderr_sha256,
    finding_ids: request.finding_ids,
    gap_ids: request.gap_ids,
    effect: request.effect,
    summary: request.summary,
    failure_code: receipt.failure_code,
  });
}
