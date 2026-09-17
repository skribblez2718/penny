import path from "node:path";

import { Type, type Static } from "typebox";

import { validateContract, type JsonValue } from "../contracts.js";
import { Sha256Schema } from "./common.js";

const MAX_SCOPE_ITEMS = 256;
const MAX_TEXT = 32_768;

export const SCA_REQUEST_SCHEMA = "penny.sca-request.v1";

const ScopePathSchema = Type.String({ minLength: 1, maxLength: 4_096 });

export const ScaRequestV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    purpose: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    source_root: Type.String({ minLength: 1, maxLength: 4_096 }),
    source_snapshot_sha256: Sha256Schema,
    scope: Type.Object(
      {
        include: Type.Array(ScopePathSchema, { maxItems: MAX_SCOPE_ITEMS }),
        exclude: Type.Array(ScopePathSchema, { maxItems: MAX_SCOPE_ITEMS }),
      },
      { additionalProperties: false }
    ),
    execution_mode: Type.Union([
      Type.Literal("static_only"),
      Type.Literal("propose_stronger_evidence"),
    ]),
    primary_a_model: Type.String({ minLength: 1, maxLength: 256 }),
    primary_b_model: Type.String({ minLength: 1, maxLength: 256 }),
    critic_model: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false }
);

export const ScaCallerConstraintsV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    source_root: ScaRequestV1Schema.properties.source_root,
    source_snapshot_sha256: ScaRequestV1Schema.properties.source_snapshot_sha256,
    scope: ScaRequestV1Schema.properties.scope,
    execution_mode: ScaRequestV1Schema.properties.execution_mode,
    primary_a_model: ScaRequestV1Schema.properties.primary_a_model,
    primary_b_model: ScaRequestV1Schema.properties.primary_b_model,
    critic_model: ScaRequestV1Schema.properties.critic_model,
  },
  { additionalProperties: false }
);

export type ScaRequestV1 = Readonly<Static<typeof ScaRequestV1Schema>>;
export type ScaCallerConstraintsV1 = Readonly<Static<typeof ScaCallerConstraintsV1Schema>>;

export class ScaRequestError extends Error {
  constructor(
    readonly code: "invalid_request" | "unsafe_source_root" | "model_profiles_not_distinct",
    message: string
  ) {
    super(message);
    this.name = "ScaRequestError";
  }
}

export function validateScaRequestV1(value: unknown): ScaRequestV1 {
  let request: ScaRequestV1;
  try {
    request = validateContract(ScaRequestV1Schema, value, "SCA request");
  } catch (error) {
    throw new ScaRequestError(
      "invalid_request",
      error instanceof Error ? error.message : "SCA request is invalid"
    );
  }
  if (!path.isAbsolute(request.source_root) || request.source_root.includes("\0")) {
    throw new ScaRequestError(
      "unsafe_source_root",
      "SCA source root must be an absolute NUL-free path"
    );
  }
  const models = [request.primary_a_model, request.primary_b_model, request.critic_model];
  if (new Set(models).size !== models.length) {
    throw new ScaRequestError(
      "model_profiles_not_distinct",
      "SCA primary and critic model profiles must be distinct"
    );
  }
  for (const entries of [request.scope.include, request.scope.exclude]) {
    if (
      new Set(entries).size !== entries.length ||
      entries.some(
        (entry) =>
          path.isAbsolute(entry) ||
          entry.includes("\0") ||
          path.posix.normalize(entry) !== entry ||
          entry === ".." ||
          entry.startsWith("../")
      )
    ) {
      throw new ScaRequestError(
        "invalid_request",
        "SCA scope paths must be unique normalized repository-relative paths"
      );
    }
  }
  return request;
}

export function canonicalizeScaRequestV1(value: {
  readonly goal: string;
  readonly constraints: Readonly<Record<string, JsonValue>>;
}): ScaRequestV1 {
  return validateScaRequestV1({ purpose: value.goal, ...value.constraints });
}

export function scaRequestConstraints(request: ScaRequestV1): Record<string, JsonValue> {
  return validateContract(
    ScaCallerConstraintsV1Schema,
    {
      schema_version: request.schema_version,
      source_root: request.source_root,
      source_snapshot_sha256: request.source_snapshot_sha256,
      scope: request.scope,
      execution_mode: request.execution_mode,
      primary_a_model: request.primary_a_model,
      primary_b_model: request.primary_b_model,
      critic_model: request.critic_model,
    },
    "SCA runtime constraints"
  );
}
