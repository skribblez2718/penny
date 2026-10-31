import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "./canonical-json.js";
import { ArtifactRefSchema, ExecutionReceiptSchema, validateContract } from "./contracts.js";

/** Registration-owned model identity for phases that must never use a catalog default or fallback. */
export interface RequiredModelIdentityV1 {
  readonly schema_version: 1;
  readonly alias: string;
  readonly override: string;
  readonly provider: string;
  readonly model: string;
}

export interface ResolvedModelIdentityV1 {
  readonly provider: string;
  readonly model: string;
}

export const MODEL_DISPATCH_GUARD_V1_SCHEMA = "penny.model-dispatch-guard.v1" as const;
export const MODEL_EXECUTION_RECEIPT_V1_SCHEMA = "penny.model-execution-receipt.v1" as const;

const RequiredModelIdentityV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    alias: Type.String({ minLength: 1, maxLength: 256 }),
    override: Type.String({ minLength: 1, maxLength: 768 }),
    provider: Type.String({ minLength: 1, maxLength: 256 }),
    model: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false }
);
const ModelExecutionCoordinateV1Schema = Type.Object(
  {
    run_id: Type.String({ minLength: 1, maxLength: 512 }),
    state_id: Type.String({ minLength: 1, maxLength: 512 }),
    branch_id: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
    agent: Type.String({ minLength: 1, maxLength: 256 }),
    attempt: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false }
);
export const ModelDispatchGuardV1Schema = Type.Object(
  {
    schema_id: Type.Literal(MODEL_DISPATCH_GUARD_V1_SCHEMA),
    schema_version: Type.Literal(1),
    coordinate: ModelExecutionCoordinateV1Schema,
    registration_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    requested_model: RequiredModelIdentityV1Schema,
    input_artifacts_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    serialized_opening_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    serialized_opening_byte_length: Type.Integer({ minimum: 1, maximum: 1_073_741_824 }),
    provider_opening_guard: Type.Union([
      Type.Literal("none"),
      Type.Literal("sca_p04_payload_disclosure_v1"),
      Type.Literal("sca_p05_payload_disclosure_v1"),
      Type.Literal("sca_p06_payload_disclosure_v1"),
      Type.Literal("sca_p08_payload_disclosure_v1"),
      Type.Literal("sca_p10_payload_disclosure_v1"),
      Type.Literal("sca_p11_payload_disclosure_v1"),
    ]),
    guarded_at: Type.String({ format: "date-time", maxLength: 64 }),
  },
  { additionalProperties: false, $id: MODEL_DISPATCH_GUARD_V1_SCHEMA }
);
export type ModelDispatchGuardV1 = Readonly<Static<typeof ModelDispatchGuardV1Schema>>;

export const ModelExecutionReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal(MODEL_EXECUTION_RECEIPT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    dispatch_guard_ref: ArtifactRefSchema,
    execution_receipt: ExecutionReceiptSchema,
  },
  { additionalProperties: false, $id: MODEL_EXECUTION_RECEIPT_V1_SCHEMA }
);
export type ModelExecutionReceiptV1 = Readonly<Static<typeof ModelExecutionReceiptV1Schema>>;

const IDENTITY_PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export function validateRequiredModelIdentity(
  value: RequiredModelIdentityV1,
  label = "required model"
): RequiredModelIdentityV1 {
  if (
    value.schema_version !== 1 ||
    !IDENTITY_PART.test(value.alias) ||
    !IDENTITY_PART.test(value.provider) ||
    value.model.length === 0 ||
    value.model.length > 512 ||
    value.override !== `${value.provider}/${value.model}`
  ) {
    throw new Error(`${label} has an invalid exact alias/provider/model/override binding`);
  }
  return value;
}

export function validateModelDispatchGuardV1(value: unknown): ModelDispatchGuardV1 {
  const guard = validateContract(ModelDispatchGuardV1Schema, value, "model dispatch guard");
  validateRequiredModelIdentity(guard.requested_model, "model dispatch guard required model");
  return guard;
}

export function validateModelExecutionReceiptV1(value: unknown): ModelExecutionReceiptV1 {
  const receipt = validateContract(
    ModelExecutionReceiptV1Schema,
    value,
    "model execution receipt artifact"
  );
  if (
    receipt.execution_receipt.requested_model === undefined ||
    receipt.execution_receipt.observed_model === undefined
  ) {
    throw new Error("model execution receipt artifact lacks requested or observed identity");
  }
  return receipt;
}

export function assertResolvedModelIdentity(
  required: RequiredModelIdentityV1,
  observed: ResolvedModelIdentityV1,
  label = "resolved model"
): ResolvedModelIdentityV1 {
  validateRequiredModelIdentity(required);
  if (observed.provider !== required.provider || observed.model !== required.model) {
    throw new Error(
      `${label} '${observed.provider}/${observed.model}' does not equal required '${required.override}'`
    );
  }
  return observed;
}

interface ModelExecutionCoordinate {
  readonly run_id: string;
  readonly state_id: string;
  readonly branch_id: string | null;
  readonly agent: string;
  readonly attempt: number;
}

function executionCoordinateSha256(input: ModelExecutionCoordinate): string {
  return sha256(canonicalJson(input));
}

export function modelDispatchGuardOperationId(input: ModelExecutionCoordinate): string {
  return `model-dispatch-guard-${executionCoordinateSha256(input)}`;
}

export function modelExecutionReceiptOperationId(input: ModelExecutionCoordinate): string {
  return `model-execution-receipt-${executionCoordinateSha256(input)}`;
}
