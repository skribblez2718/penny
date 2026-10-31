import { Type, type Static, type TSchema } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract } from "../contracts.js";
import {
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  Sha256Schema,
  assertOpaqueId,
  assertRfc3339Utc,
} from "../skill-contracts/common.js";

export const SCA_ACTIVATION_AUTHORITY_V1_SCHEMA = "penny.sca-activation-authority.v1";
export const SCA_ACTIVATION_ISSUANCE_V1_SCHEMA = "penny.sca-activation-issuance.v1";

/** A scope is inert data: it contains neither a registry operation nor execution instructions. */
export const ScaActivationScopeV1Schema = Type.Object(
  {
    authority_id: OpaqueIdSchema,
    nonce: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    phase_id: OpaqueIdSchema,
    production_playbook_name: OpaqueIdSchema,
    qualification_run_id: OpaqueIdSchema,
    activation_run_id: OpaqueIdSchema,
    decision: Type.Literal("authorize_activation_admission"),
    qualification_ref: ArtifactRefSchema,
    gate_ref: ArtifactRefSchema,
    implementation_identity_ref: ArtifactRefSchema,
    qualification_policy_data_sha256: Sha256Schema,
    registration_contract_sha256: Sha256Schema,
    runtime_registration_sha256: Sha256Schema,
    host_implementation_binding_sha256: Sha256Schema,
    operator_principal_id: OpaqueIdSchema,
    issuer_policy_id: OpaqueIdSchema,
    proposed_start_sha256: Sha256Schema,
    issued_at: Rfc3339UtcSchema,
    not_before: Rfc3339UtcSchema,
    expires_at: Rfc3339UtcSchema,
    revocation_generation: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  },
  { additionalProperties: false }
);
export type ScaActivationScopeV1 = Readonly<Static<typeof ScaActivationScopeV1Schema>>;

export const ScaActivationIssuanceV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_ACTIVATION_ISSUANCE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    issuance_id: OpaqueIdSchema,
    authority_id: OpaqueIdSchema,
    operator_principal_id: OpaqueIdSchema,
    issuer_policy_id: OpaqueIdSchema,
    scope_sha256: Sha256Schema,
    /** Issuer-owned time, independently verified by the trusted external issuer owner. */
    issued_at: Rfc3339UtcSchema,
    issuance_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_ACTIVATION_ISSUANCE_V1_SCHEMA }
);
export type ScaActivationIssuanceV1 = Readonly<Static<typeof ScaActivationIssuanceV1Schema>>;

export const ScaActivationAuthorityV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_ACTIVATION_AUTHORITY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    scope: ScaActivationScopeV1Schema,
    issuance_record_ref: ArtifactRefSchema,
    authority_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_ACTIVATION_AUTHORITY_V1_SCHEMA }
);
export type ScaActivationAuthorityV1 = Readonly<Static<typeof ScaActivationAuthorityV1Schema>>;

function validate<Schema extends TSchema>(schema: Schema, value: unknown): Static<Schema> {
  return validateContract(schema, value, "SCA activation artifact");
}

function assertSelfDigest(value: string, unsigned: unknown): void {
  if (value !== sha256(canonicalJson(unsigned))) throw new Error("invalid self-digest");
}

export function validateScaActivationIssuanceV1(value: unknown): ScaActivationIssuanceV1 {
  const record = validate(ScaActivationIssuanceV1Schema, value);
  for (const id of [
    record.issuance_id,
    record.authority_id,
    record.operator_principal_id,
    record.issuer_policy_id,
  ]) {
    assertOpaqueId(id, "activation issuance ID");
  }
  assertRfc3339Utc(record.issued_at, "activation issuance time");
  const { issuance_sha256, ...unsigned } = record;
  assertSelfDigest(issuance_sha256, unsigned);
  return record;
}

export function validateScaActivationAuthorityV1(value: unknown): ScaActivationAuthorityV1 {
  const authority = validate(ScaActivationAuthorityV1Schema, value);
  const scope = authority.scope;
  for (const id of [
    scope.authority_id,
    scope.nonce,
    scope.tenant_id,
    scope.project_id,
    scope.phase_id,
    scope.production_playbook_name,
    scope.qualification_run_id,
    scope.activation_run_id,
    scope.operator_principal_id,
    scope.issuer_policy_id,
  ])
    assertOpaqueId(id, "activation scope ID");
  for (const time of [scope.issued_at, scope.not_before, scope.expires_at]) {
    assertRfc3339Utc(time, "activation time");
  }
  if (
    scope.qualification_run_id === scope.activation_run_id ||
    Date.parse(scope.issued_at) > Date.parse(scope.not_before) ||
    Date.parse(scope.not_before) >= Date.parse(scope.expires_at)
  )
    throw new Error("invalid activation interval or runs");
  const { authority_sha256, ...unsigned } = authority;
  assertSelfDigest(authority_sha256, unsigned);
  return authority;
}

/** Sealing is not issuance. Only the host issuer's independent authenticated ledger can issue. */
export function sealScaActivationIssuanceV1(
  unsigned: Omit<ScaActivationIssuanceV1, "issuance_sha256">
): ScaActivationIssuanceV1 {
  return validateScaActivationIssuanceV1({
    ...unsigned,
    issuance_sha256: sha256(canonicalJson(unsigned)),
  });
}

/** Sealing is not authorization; callers cannot mint an operator decision by hashing JSON. */
export function sealScaActivationAuthorityV1(
  unsigned: Omit<ScaActivationAuthorityV1, "authority_sha256">
): ScaActivationAuthorityV1 {
  return validateScaActivationAuthorityV1({
    ...unsigned,
    authority_sha256: sha256(canonicalJson(unsigned)),
  });
}
