import { Type, type Static, type TSchema } from "typebox";

import { ArtifactRefSchema, type CurrentArtifactRef, validateContract } from "../contracts.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  Sha256Schema,
  assertOpaqueId,
} from "../skill-contracts/common.js";

const SAFE_TOKEN_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const PARAMETER_NAME_PATTERN = "^[a-z][a-z0-9_]{0,63}$";
const PARAMETER_IDENTIFIER_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const REPOSITORY_PATH_MAX_BYTES = 1_024;
const SAFE_TEXT_MAX_BYTES = 1_024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 4_096;

/**
 * Keep broker contract validation independent of the artifact store and its
 * runtime state dependencies so extensions can load on bundled Node paths.
 */
function currentScaArtifactRef(value: unknown, label: string): CurrentArtifactRef {
  const ref = validateContract(ArtifactRefSchema, value, label);
  const normalized: CurrentArtifactRef = {
    schema_version: 2,
    artifact_id: ref.artifact_id,
    run_id: ref.run_id,
    phase: ref.phase,
    branch_id: ref.branch_id,
    kind: ref.kind,
    operation_id: ref.operation_id,
    version: ref.version,
    producer: ref.producer,
    media_type: ref.media_type,
    ...(ref.content_schema === undefined ? {} : { content_schema: ref.content_schema }),
    byte_length: ref.byte_length,
    content_digest: ref.content_digest,
    store_ref: ref.store_ref,
  };
  const identity = {
    branch_id: normalized.branch_id,
    kind: normalized.kind,
    operation_id: normalized.operation_id,
    phase: normalized.phase,
    run_id: normalized.run_id,
    version: normalized.version,
  };
  if (normalized.artifact_id !== `art_${sha256(canonicalJson(identity))}`) {
    throw new Error(`${label}.artifact_id does not match its canonical identity`);
  }
  if (normalized.store_ref !== `artifact://sha256/${normalized.content_digest}`) {
    throw new Error(`${label}.store_ref does not match content_digest`);
  }
  return normalized;
}

export const SCA_BROKER_CONTRACT_LIMITS_V1 = Object.freeze({
  max_request_bytes: 262_144,
  max_input_refs: 16,
  max_output_refs: 16,
  max_selectors: 32,
  max_parameters: 32,
  max_timeout_ms: 300_000,
  max_poll_timeout_ms: 30_000,
  max_deadline_window_ms: 86_400_000,
  max_output_bytes: 16_777_216,
  max_result_items: 10_000,
});

export const SCA_BROKER_PROGRESS_LIMITS_V1 = Object.freeze({
  max_sequence: 1_000_000,
  max_work_units: 1_000_000,
});

export const SCA_TOOL_OPERATION_MAP = Object.freeze({
  sca_source_query: "source_query",
  sca_graph_query: "graph_query",
  sca_application_test: "application_test",
} as const);

export const SCA_MODEL_TOOL_ROSTER = Object.freeze([
  "sca_source_query",
  "sca_graph_query",
  "sca_application_test",
] as const);

export const ScaBrokerToolNameSchema = Type.Union(
  [
    Type.Literal("sca_source_query"),
    Type.Literal("sca_graph_query"),
    Type.Literal("sca_application_test"),
  ],
  { $id: "penny.sca-broker-tool-name.v1" }
);
export type ScaBrokerToolName = Static<typeof ScaBrokerToolNameSchema>;

export const ScaBrokerOperationKindSchema = Type.Union(
  [Type.Literal("source_query"), Type.Literal("graph_query"), Type.Literal("application_test")],
  { $id: "penny.sca-broker-operation-kind.v1" }
);
export type ScaBrokerOperationKind = Static<typeof ScaBrokerOperationKindSchema>;

export const ScaBrokerErrorCodeSchema = Type.Union(
  [
    Type.Literal("service_unavailable"),
    Type.Literal("unsupported_operation"),
    Type.Literal("invalid_request"),
    Type.Literal("unauthorized"),
    Type.Literal("conflict"),
    Type.Literal("quota_exceeded"),
    Type.Literal("timeout"),
    Type.Literal("cancelled"),
    Type.Literal("failed"),
    Type.Literal("output_truncated"),
  ],
  { $id: "penny.sca-broker-error-code.v1" }
);
export type ScaBrokerErrorCode = Static<typeof ScaBrokerErrorCodeSchema>;

export const ScaBrokerTypedErrorV1Schema = Type.Object(
  {
    code: ScaBrokerErrorCodeSchema,
    message: Type.String({ minLength: 1, maxLength: SAFE_TEXT_MAX_BYTES }),
  },
  {
    $id: "penny.sca-broker-typed-error.v1",
    additionalProperties: false,
  }
);
export type ScaBrokerTypedErrorV1 = Static<typeof ScaBrokerTypedErrorV1Schema>;

const RepositoryLineRangeV1Schema = Type.Object(
  {
    start_line: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    end_line_exclusive: Type.Integer({ minimum: 2, maximum: 10_000_001 }),
  },
  { additionalProperties: false }
);

export const ScaBrokerRepositorySelectorV1Schema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: REPOSITORY_PATH_MAX_BYTES }),
    line_range: Type.Union([RepositoryLineRangeV1Schema, Type.Null()]),
    symbol: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
  },
  {
    $id: "penny.sca-broker-repository-selector.v1",
    additionalProperties: false,
  }
);
export type ScaBrokerRepositorySelectorV1 = Static<typeof ScaBrokerRepositorySelectorV1Schema>;

const ScaBrokerParameterValueV1Schema = Type.Union([
  Type.Object(
    { kind: Type.Literal("boolean"), value: Type.Boolean() },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("integer"),
      value: Type.Integer({ minimum: -1_000_000, maximum: 1_000_000 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("identifier"),
      value: Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: PARAMETER_IDENTIFIER_PATTERN,
      }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("literal"),
      value: Type.String({ minLength: 1, maxLength: SAFE_TEXT_MAX_BYTES }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    { kind: Type.Literal("sha256"), value: Sha256Schema },
    { additionalProperties: false }
  ),
]);

export const ScaBrokerTypedParameterV1Schema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: PARAMETER_NAME_PATTERN,
    }),
    value: ScaBrokerParameterValueV1Schema,
  },
  {
    $id: "penny.sca-broker-typed-parameter.v1",
    additionalProperties: false,
  }
);
export type ScaBrokerTypedParameterV1 = Static<typeof ScaBrokerTypedParameterV1Schema>;

export const ScaBrokerRequestLimitsV1Schema = Type.Object(
  {
    timeout_ms: Type.Integer({
      minimum: 1,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_timeout_ms,
    }),
    max_output_bytes: Type.Integer({
      minimum: 1,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_output_bytes,
    }),
    max_result_items: Type.Integer({
      minimum: 1,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_result_items,
    }),
  },
  {
    $id: "penny.sca-broker-request-limits.v1",
    additionalProperties: false,
  }
);
export type ScaBrokerRequestLimitsV1 = Static<typeof ScaBrokerRequestLimitsV1Schema>;

const ScaBrokerCapabilityLimitsV1Schema = Type.Object(
  {
    max_request_bytes: Type.Integer({
      minimum: 1,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_request_bytes,
    }),
    max_input_refs: Type.Integer({
      minimum: 1,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_input_refs,
    }),
    max_output_refs: Type.Integer({
      minimum: 1,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_output_refs,
    }),
    max_selectors: Type.Integer({
      minimum: 1,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_selectors,
    }),
    max_parameters: Type.Integer({
      minimum: 1,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_parameters,
    }),
    max_timeout_ms: Type.Integer({
      minimum: 1,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_timeout_ms,
    }),
    max_output_bytes: Type.Integer({
      minimum: 1,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_output_bytes,
    }),
    max_result_items: Type.Integer({
      minimum: 1,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_result_items,
    }),
  },
  { additionalProperties: false }
);

const BrokerScopeFields = {
  tenant_id: OpaqueIdSchema,
  project_id: OpaqueIdSchema,
  run_id: OpaqueIdSchema,
} as const;

const BrokerJobFields = {
  ...BrokerScopeFields,
  job_id: OpaqueIdSchema,
  attempt: Type.Integer({ minimum: 1, maximum: 1_000 }),
  idempotency_key: Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: SAFE_TOKEN_PATTERN,
  }),
} as const;

const BrokerOperationFields = {
  tool_name: ScaBrokerToolNameSchema,
  operation: ScaBrokerOperationKindSchema,
} as const;

const NullableTypedErrorSchema = Type.Union([ScaBrokerTypedErrorV1Schema, Type.Null()]);

export const ScaBrokerCapabilityRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-broker-capability-request.v1"),
    schema_version: Type.Literal(1),
    ...BrokerScopeFields,
    request_id: OpaqueIdSchema,
    ...BrokerOperationFields,
    requested_at: Rfc3339UtcSchema,
    deadline_at: Rfc3339UtcSchema,
    timeout_ms: Type.Integer({
      minimum: 1,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_timeout_ms,
    }),
  },
  {
    $id: "penny.sca-broker-capability-request.v1",
    additionalProperties: false,
  }
);
export type ScaBrokerCapabilityRequestV1 = Static<typeof ScaBrokerCapabilityRequestV1Schema>;

export const ScaBrokerCapabilityResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-broker-capability-result.v1"),
    schema_version: Type.Literal(1),
    ...BrokerScopeFields,
    request_id: OpaqueIdSchema,
    ...BrokerOperationFields,
    status: Type.Union([Type.Literal("available"), Type.Literal("unavailable")]),
    limits: Type.Union([ScaBrokerCapabilityLimitsV1Schema, Type.Null()]),
    error: NullableTypedErrorSchema,
    observed_at: Rfc3339UtcSchema,
  },
  {
    $id: "penny.sca-broker-capability-result.v1",
    additionalProperties: false,
  }
);
export type ScaBrokerCapabilityResultV1 = Static<typeof ScaBrokerCapabilityResultV1Schema>;

const QueryFields = {
  query_id: Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: SAFE_TOKEN_PATTERN,
  }),
  selectors: Type.Array(ScaBrokerRepositorySelectorV1Schema, {
    minItems: 1,
    maxItems: SCA_BROKER_CONTRACT_LIMITS_V1.max_selectors,
  }),
  parameters: Type.Array(ScaBrokerTypedParameterV1Schema, {
    maxItems: SCA_BROKER_CONTRACT_LIMITS_V1.max_parameters,
  }),
} as const;

const ScaSourceQueryInputV1Schema = Type.Object(
  {
    kind: Type.Literal("source_query"),
    ...QueryFields,
  },
  { additionalProperties: false }
);

const ScaGraphQueryInputV1Schema = Type.Object(
  {
    kind: Type.Literal("graph_query"),
    graph_ref: ArtifactRefSchema,
    ...QueryFields,
  },
  { additionalProperties: false }
);

const ScaApplicationTestInputV1Schema = Type.Object(
  {
    kind: Type.Literal("application_test"),
    execution_plan_ref: ArtifactRefSchema,
    policy_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);

const ScaBrokerOperationInputV1Schema = Type.Union([
  ScaSourceQueryInputV1Schema,
  ScaGraphQueryInputV1Schema,
  ScaApplicationTestInputV1Schema,
]);

export const ScaBrokerExecuteRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-broker-execute-request.v1"),
    schema_version: Type.Literal(1),
    ...BrokerJobFields,
    ...BrokerOperationFields,
    submitted_at: Rfc3339UtcSchema,
    deadline_at: Rfc3339UtcSchema,
    limits: ScaBrokerRequestLimitsV1Schema,
    source_snapshot_ref: ArtifactRefSchema,
    config_ref: ArtifactRefSchema,
    input_refs: Type.Array(ArtifactRefSchema, {
      maxItems: SCA_BROKER_CONTRACT_LIMITS_V1.max_input_refs,
    }),
    operation_input: ScaBrokerOperationInputV1Schema,
  },
  {
    $id: "penny.sca-broker-execute-request.v1",
    additionalProperties: false,
  }
);
export type ScaBrokerExecuteRequestV1 = Static<typeof ScaBrokerExecuteRequestV1Schema>;

export const ScaBrokerExecuteAcceptedResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-broker-execute-accepted-result.v1"),
    schema_version: Type.Literal(1),
    ...BrokerJobFields,
    ...BrokerOperationFields,
    status: Type.Literal("accepted"),
    request_sha256: Sha256Schema,
    accepted_at: Rfc3339UtcSchema,
  },
  {
    $id: "penny.sca-broker-execute-accepted-result.v1",
    additionalProperties: false,
  }
);
export type ScaBrokerExecuteAcceptedResultV1 = Static<
  typeof ScaBrokerExecuteAcceptedResultV1Schema
>;

export const ScaBrokerPollRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-broker-poll-request.v1"),
    schema_version: Type.Literal(1),
    ...BrokerJobFields,
    ...BrokerOperationFields,
    request_sha256: Sha256Schema,
    requested_at: Rfc3339UtcSchema,
    deadline_at: Rfc3339UtcSchema,
    poll_timeout_ms: Type.Integer({
      minimum: 1,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_poll_timeout_ms,
    }),
  },
  {
    $id: "penny.sca-broker-poll-request.v1",
    additionalProperties: false,
  }
);
export type ScaBrokerPollRequestV1 = Static<typeof ScaBrokerPollRequestV1Schema>;

export const ScaBrokerTerminalStatusSchema = Type.Union(
  [
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("timed_out"),
    Type.Literal("cancelled"),
  ],
  { $id: "penny.sca-broker-terminal-status.v1" }
);
export type ScaBrokerTerminalStatus = Static<typeof ScaBrokerTerminalStatusSchema>;

export const ScaBrokerReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-broker-receipt.v1"),
    schema_version: Type.Literal(1),
    ...BrokerJobFields,
    receipt_id: OpaqueIdSchema,
    ...BrokerOperationFields,
    request_sha256: Sha256Schema,
    limits: ScaBrokerRequestLimitsV1Schema,
    terminal_status: ScaBrokerTerminalStatusSchema,
    partial: Type.Boolean(),
    truncated: Type.Boolean(),
    source_snapshot_ref: ArtifactRefSchema,
    config_ref: ArtifactRefSchema,
    input_refs: Type.Array(ArtifactRefSchema, {
      maxItems: SCA_BROKER_CONTRACT_LIMITS_V1.max_input_refs,
    }),
    output_refs: Type.Array(ArtifactRefSchema, {
      maxItems: SCA_BROKER_CONTRACT_LIMITS_V1.max_output_refs,
    }),
    result_item_count: Type.Integer({
      minimum: 0,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_result_items,
    }),
    failure: NullableTypedErrorSchema,
    accepted_at: Rfc3339UtcSchema,
    terminal_at: Rfc3339UtcSchema,
  },
  {
    $id: "penny.sca-broker-receipt.v1",
    additionalProperties: false,
  }
);
export type ScaBrokerReceiptV1 = Static<typeof ScaBrokerReceiptV1Schema>;

export const ScaBrokerPollResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-broker-poll-result.v1"),
    schema_version: Type.Literal(1),
    ...BrokerJobFields,
    ...BrokerOperationFields,
    request_sha256: Sha256Schema,
    status: Type.Union([
      Type.Literal("accepted"),
      Type.Literal("running"),
      ScaBrokerTerminalStatusSchema,
    ]),
    partial: Type.Boolean(),
    truncated: Type.Boolean(),
    output_refs: Type.Array(ArtifactRefSchema, {
      maxItems: SCA_BROKER_CONTRACT_LIMITS_V1.max_output_refs,
    }),
    result_item_count: Type.Integer({
      minimum: 0,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_result_items,
    }),
    failure: NullableTypedErrorSchema,
    receipt: Type.Union([ScaBrokerReceiptV1Schema, Type.Null()]),
    observed_at: Rfc3339UtcSchema,
  },
  {
    $id: "penny.sca-broker-poll-result.v1",
    additionalProperties: false,
  }
);
export type ScaBrokerPollResultV1 = Static<typeof ScaBrokerPollResultV1Schema>;

export const ScaBrokerJobProgressV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-broker-job-progress.v1"),
    schema_version: Type.Literal(1),
    ...BrokerJobFields,
    ...BrokerOperationFields,
    request_sha256: Sha256Schema,
    sequence: Type.Integer({
      minimum: 0,
      maximum: SCA_BROKER_PROGRESS_LIMITS_V1.max_sequence,
    }),
    phase: Type.Union([
      Type.Literal("accepted"),
      Type.Literal("executing"),
      Type.Literal("materializing_output"),
    ]),
    work_units: Type.Integer({
      minimum: 0,
      maximum: SCA_BROKER_PROGRESS_LIMITS_V1.max_work_units,
    }),
    output_bytes: Type.Integer({
      minimum: 0,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_output_bytes,
    }),
    result_items: Type.Integer({
      minimum: 0,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_result_items,
    }),
  },
  {
    $id: "penny.sca-broker-job-progress.v1",
    additionalProperties: false,
  }
);
export type ScaBrokerJobProgressV1 = Static<typeof ScaBrokerJobProgressV1Schema>;

export const ScaBrokerExecuteAcceptedResultV2Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-broker-execute-accepted-result.v2"),
    schema_version: Type.Literal(2),
    ...BrokerJobFields,
    ...BrokerOperationFields,
    status: Type.Literal("accepted"),
    request_sha256: Sha256Schema,
    accepted_at: Rfc3339UtcSchema,
    progress: ScaBrokerJobProgressV1Schema,
  },
  {
    $id: "penny.sca-broker-execute-accepted-result.v2",
    additionalProperties: false,
  }
);
export type ScaBrokerExecuteAcceptedResultV2 = Static<
  typeof ScaBrokerExecuteAcceptedResultV2Schema
>;

export const ScaBrokerPollResultV2Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-broker-poll-result.v2"),
    schema_version: Type.Literal(2),
    ...BrokerJobFields,
    ...BrokerOperationFields,
    request_sha256: Sha256Schema,
    status: Type.Union([
      Type.Literal("accepted"),
      Type.Literal("running"),
      ScaBrokerTerminalStatusSchema,
    ]),
    progress: ScaBrokerJobProgressV1Schema,
    partial: Type.Boolean(),
    truncated: Type.Boolean(),
    output_refs: Type.Array(ArtifactRefSchema, {
      maxItems: SCA_BROKER_CONTRACT_LIMITS_V1.max_output_refs,
    }),
    result_item_count: Type.Integer({
      minimum: 0,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_result_items,
    }),
    failure: NullableTypedErrorSchema,
    receipt: Type.Union([ScaBrokerReceiptV1Schema, Type.Null()]),
    observed_at: Rfc3339UtcSchema,
  },
  {
    $id: "penny.sca-broker-poll-result.v2",
    additionalProperties: false,
  }
);
export type ScaBrokerPollResultV2 = Static<typeof ScaBrokerPollResultV2Schema>;

export type ScaBrokerExecuteAcceptedResult =
  | ScaBrokerExecuteAcceptedResultV1
  | ScaBrokerExecuteAcceptedResultV2;
export type ScaBrokerPollResult = ScaBrokerPollResultV1 | ScaBrokerPollResultV2;

export const ScaBrokerCancelRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-broker-cancel-request.v1"),
    schema_version: Type.Literal(1),
    ...BrokerJobFields,
    ...BrokerOperationFields,
    request_sha256: Sha256Schema,
    reason: Type.Union([
      Type.Literal("caller_requested"),
      Type.Literal("deadline_exceeded"),
      Type.Literal("parent_cancelled"),
    ]),
    requested_at: Rfc3339UtcSchema,
    deadline_at: Rfc3339UtcSchema,
    timeout_ms: Type.Integer({
      minimum: 1,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_timeout_ms,
    }),
  },
  {
    $id: "penny.sca-broker-cancel-request.v1",
    additionalProperties: false,
  }
);
export type ScaBrokerCancelRequestV1 = Static<typeof ScaBrokerCancelRequestV1Schema>;

export const ScaBrokerCancelResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-broker-cancel-result.v1"),
    schema_version: Type.Literal(1),
    ...BrokerJobFields,
    ...BrokerOperationFields,
    request_sha256: Sha256Schema,
    outcome: Type.Union([
      Type.Literal("cancel_requested"),
      Type.Literal("terminal"),
      Type.Literal("rejected"),
    ]),
    terminal_status: Type.Union([ScaBrokerTerminalStatusSchema, Type.Null()]),
    receipt: Type.Union([ScaBrokerReceiptV1Schema, Type.Null()]),
    error: NullableTypedErrorSchema,
    observed_at: Rfc3339UtcSchema,
  },
  {
    $id: "penny.sca-broker-cancel-result.v1",
    additionalProperties: false,
  }
);
export type ScaBrokerCancelResultV1 = Static<typeof ScaBrokerCancelResultV1Schema>;

const ScaBrokerSchemaDigestEntryV1Schema = Type.Object(
  {
    export_name: Type.String({ minLength: 1, maxLength: 128 }),
    schema_id: Type.String({ minLength: 1, maxLength: 128 }),
    sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const ScaBrokerConsumerExpectationV1Schema = Type.Object(
  {
    module_path: Type.Union([
      Type.Literal("apps/sca-service/src/contracts.ts"),
      Type.Literal(".pi/extensions/sca/src/contracts.ts"),
    ]),
    integration: Type.Literal("generated_digest_lock_v1"),
    canonical_source: Type.Literal("apps/orchestration/src/sca/broker-contracts.ts"),
    generated_bundle_export: Type.Literal("SCA_BROKER_SCHEMA_BUNDLE_V1"),
    manifest_export: Type.Literal("SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V1"),
  },
  { additionalProperties: false }
);

const ScaBrokerToolMappingEntryV1Schema = Type.Object(
  {
    tool_name: ScaBrokerToolNameSchema,
    operation: ScaBrokerOperationKindSchema,
  },
  { additionalProperties: false }
);

export const ScaBrokerSchemaDigestManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-broker-schema-digest-manifest.v1"),
    schema_version: Type.Literal(1),
    canonical_source: Type.Literal("apps/orchestration/src/sca/broker-contracts.ts"),
    generated_bundle_export: Type.Literal("SCA_BROKER_SCHEMA_BUNDLE_V1"),
    semantic_profile: Type.Literal("penny.sca-broker-semantics.v1"),
    semantic_limits: Type.Object(
      {
        max_request_bytes: Type.Integer({ minimum: 1 }),
        max_input_refs: Type.Integer({ minimum: 1 }),
        max_output_refs: Type.Integer({ minimum: 1 }),
        max_selectors: Type.Integer({ minimum: 1 }),
        max_parameters: Type.Integer({ minimum: 1 }),
        max_timeout_ms: Type.Integer({ minimum: 1 }),
        max_poll_timeout_ms: Type.Integer({ minimum: 1 }),
        max_deadline_window_ms: Type.Integer({ minimum: 1 }),
        max_output_bytes: Type.Integer({ minimum: 1 }),
        max_result_items: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false }
    ),
    tool_operation_map: Type.Array(ScaBrokerToolMappingEntryV1Schema, {
      minItems: 3,
      maxItems: 3,
    }),
    schema_digests: Type.Array(ScaBrokerSchemaDigestEntryV1Schema, {
      minItems: 1,
    }),
    consumers: Type.Array(ScaBrokerConsumerExpectationV1Schema, {
      minItems: 2,
      maxItems: 2,
    }),
    manifest_sha256: Sha256Schema,
  },
  {
    $id: "penny.sca-broker-schema-digest-manifest.v1",
    additionalProperties: false,
  }
);
export type ScaBrokerSchemaDigestManifestV1 = Static<typeof ScaBrokerSchemaDigestManifestV1Schema>;

const ScaBrokerConsumerExpectationV2Schema = Type.Object(
  {
    module_path: Type.Union([
      Type.Literal("apps/sca-service/src/contracts.ts"),
      Type.Literal(".pi/extensions/sca/src/contracts.ts"),
    ]),
    integration: Type.Literal("generated_digest_lock_v2"),
    canonical_source: Type.Literal("apps/orchestration/src/sca/broker-contracts.ts"),
    generated_bundle_export: Type.Literal("SCA_BROKER_SCHEMA_BUNDLE_V2"),
    manifest_export: Type.Literal("SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V2"),
  },
  { additionalProperties: false }
);

export const ScaBrokerSchemaDigestManifestV2Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-broker-schema-digest-manifest.v2"),
    schema_version: Type.Literal(2),
    canonical_source: Type.Literal("apps/orchestration/src/sca/broker-contracts.ts"),
    generated_bundle_export: Type.Literal("SCA_BROKER_SCHEMA_BUNDLE_V2"),
    semantic_profile: Type.Literal("penny.sca-broker-semantics.v2"),
    semantic_limits: Type.Object(
      {
        max_request_bytes: Type.Integer({ minimum: 1 }),
        max_input_refs: Type.Integer({ minimum: 1 }),
        max_output_refs: Type.Integer({ minimum: 1 }),
        max_selectors: Type.Integer({ minimum: 1 }),
        max_parameters: Type.Integer({ minimum: 1 }),
        max_timeout_ms: Type.Integer({ minimum: 1 }),
        max_poll_timeout_ms: Type.Integer({ minimum: 1 }),
        max_deadline_window_ms: Type.Integer({ minimum: 1 }),
        max_output_bytes: Type.Integer({ minimum: 1 }),
        max_result_items: Type.Integer({ minimum: 1 }),
        max_progress_sequence: Type.Integer({ minimum: 1 }),
        max_progress_work_units: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false }
    ),
    tool_operation_map: Type.Array(ScaBrokerToolMappingEntryV1Schema, {
      minItems: 3,
      maxItems: 3,
    }),
    schema_digests: Type.Array(ScaBrokerSchemaDigestEntryV1Schema, {
      minItems: 1,
    }),
    consumers: Type.Array(ScaBrokerConsumerExpectationV2Schema, {
      minItems: 2,
      maxItems: 2,
    }),
    manifest_sha256: Sha256Schema,
  },
  {
    $id: "penny.sca-broker-schema-digest-manifest.v2",
    additionalProperties: false,
  }
);
export type ScaBrokerSchemaDigestManifestV2 = Static<typeof ScaBrokerSchemaDigestManifestV2Schema>;

export const SCA_BROKER_SCHEMA_BUNDLE_V1 = Object.freeze({
  ScaBrokerToolNameSchema,
  ScaBrokerOperationKindSchema,
  ScaBrokerErrorCodeSchema,
  ScaBrokerTypedErrorV1Schema,
  ScaBrokerRepositorySelectorV1Schema,
  ScaBrokerTypedParameterV1Schema,
  ScaBrokerRequestLimitsV1Schema,
  ScaBrokerCapabilityRequestV1Schema,
  ScaBrokerCapabilityResultV1Schema,
  ScaBrokerExecuteRequestV1Schema,
  ScaBrokerExecuteAcceptedResultV1Schema,
  ScaBrokerPollRequestV1Schema,
  ScaBrokerTerminalStatusSchema,
  ScaBrokerReceiptV1Schema,
  ScaBrokerPollResultV1Schema,
  ScaBrokerCancelRequestV1Schema,
  ScaBrokerCancelResultV1Schema,
  ScaBrokerSchemaDigestManifestV1Schema,
});

export const SCA_BROKER_SCHEMA_BUNDLE_V2 = Object.freeze({
  ...SCA_BROKER_SCHEMA_BUNDLE_V1,
  ScaBrokerJobProgressV1Schema,
  ScaBrokerExecuteAcceptedResultV2Schema,
  ScaBrokerPollResultV2Schema,
  ScaBrokerSchemaDigestManifestV2Schema,
});

const SCHEMA_DEFINITIONS_V1 = [
  {
    export_name: "ScaBrokerToolNameSchema",
    schema_id: "penny.sca-broker-tool-name.v1",
    schema: ScaBrokerToolNameSchema,
  },
  {
    export_name: "ScaBrokerOperationKindSchema",
    schema_id: "penny.sca-broker-operation-kind.v1",
    schema: ScaBrokerOperationKindSchema,
  },
  {
    export_name: "ScaBrokerErrorCodeSchema",
    schema_id: "penny.sca-broker-error-code.v1",
    schema: ScaBrokerErrorCodeSchema,
  },
  {
    export_name: "ScaBrokerTypedErrorV1Schema",
    schema_id: "penny.sca-broker-typed-error.v1",
    schema: ScaBrokerTypedErrorV1Schema,
  },
  {
    export_name: "ScaBrokerRepositorySelectorV1Schema",
    schema_id: "penny.sca-broker-repository-selector.v1",
    schema: ScaBrokerRepositorySelectorV1Schema,
  },
  {
    export_name: "ScaBrokerTypedParameterV1Schema",
    schema_id: "penny.sca-broker-typed-parameter.v1",
    schema: ScaBrokerTypedParameterV1Schema,
  },
  {
    export_name: "ScaBrokerRequestLimitsV1Schema",
    schema_id: "penny.sca-broker-request-limits.v1",
    schema: ScaBrokerRequestLimitsV1Schema,
  },
  {
    export_name: "ScaBrokerCapabilityRequestV1Schema",
    schema_id: "penny.sca-broker-capability-request.v1",
    schema: ScaBrokerCapabilityRequestV1Schema,
  },
  {
    export_name: "ScaBrokerCapabilityResultV1Schema",
    schema_id: "penny.sca-broker-capability-result.v1",
    schema: ScaBrokerCapabilityResultV1Schema,
  },
  {
    export_name: "ScaBrokerExecuteRequestV1Schema",
    schema_id: "penny.sca-broker-execute-request.v1",
    schema: ScaBrokerExecuteRequestV1Schema,
  },
  {
    export_name: "ScaBrokerExecuteAcceptedResultV1Schema",
    schema_id: "penny.sca-broker-execute-accepted-result.v1",
    schema: ScaBrokerExecuteAcceptedResultV1Schema,
  },
  {
    export_name: "ScaBrokerPollRequestV1Schema",
    schema_id: "penny.sca-broker-poll-request.v1",
    schema: ScaBrokerPollRequestV1Schema,
  },
  {
    export_name: "ScaBrokerTerminalStatusSchema",
    schema_id: "penny.sca-broker-terminal-status.v1",
    schema: ScaBrokerTerminalStatusSchema,
  },
  {
    export_name: "ScaBrokerReceiptV1Schema",
    schema_id: "penny.sca-broker-receipt.v1",
    schema: ScaBrokerReceiptV1Schema,
  },
  {
    export_name: "ScaBrokerPollResultV1Schema",
    schema_id: "penny.sca-broker-poll-result.v1",
    schema: ScaBrokerPollResultV1Schema,
  },
  {
    export_name: "ScaBrokerCancelRequestV1Schema",
    schema_id: "penny.sca-broker-cancel-request.v1",
    schema: ScaBrokerCancelRequestV1Schema,
  },
  {
    export_name: "ScaBrokerCancelResultV1Schema",
    schema_id: "penny.sca-broker-cancel-result.v1",
    schema: ScaBrokerCancelResultV1Schema,
  },
  {
    export_name: "ScaBrokerSchemaDigestManifestV1Schema",
    schema_id: "penny.sca-broker-schema-digest-manifest.v1",
    schema: ScaBrokerSchemaDigestManifestV1Schema,
  },
] satisfies readonly {
  readonly export_name: string;
  readonly schema_id: string;
  readonly schema: TSchema;
}[];

const CONSUMER_EXPECTATIONS_V1 = [
  {
    module_path: "apps/sca-service/src/contracts.ts",
    integration: "generated_digest_lock_v1",
    canonical_source: "apps/orchestration/src/sca/broker-contracts.ts",
    generated_bundle_export: "SCA_BROKER_SCHEMA_BUNDLE_V1",
    manifest_export: "SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V1",
  },
  {
    module_path: ".pi/extensions/sca/src/contracts.ts",
    integration: "generated_digest_lock_v1",
    canonical_source: "apps/orchestration/src/sca/broker-contracts.ts",
    generated_bundle_export: "SCA_BROKER_SCHEMA_BUNDLE_V1",
    manifest_export: "SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V1",
  },
] as const;

const TOOL_OPERATION_ENTRIES = [
  { tool_name: "sca_source_query", operation: "source_query" },
  { tool_name: "sca_graph_query", operation: "graph_query" },
  { tool_name: "sca_application_test", operation: "application_test" },
] as const;

export function scaBrokerSchemaSha256(schema: TSchema): string {
  return sha256(canonicalJson(schema));
}

const SCHEMA_MANIFEST_PREIMAGE_V1 = {
  schema_id: "penny.sca-broker-schema-digest-manifest.v1",
  schema_version: 1,
  canonical_source: "apps/orchestration/src/sca/broker-contracts.ts",
  generated_bundle_export: "SCA_BROKER_SCHEMA_BUNDLE_V1",
  semantic_profile: "penny.sca-broker-semantics.v1",
  semantic_limits: SCA_BROKER_CONTRACT_LIMITS_V1,
  tool_operation_map: TOOL_OPERATION_ENTRIES,
  schema_digests: SCHEMA_DEFINITIONS_V1.map((definition) => ({
    export_name: definition.export_name,
    schema_id: definition.schema_id,
    sha256: scaBrokerSchemaSha256(definition.schema),
  })),
  consumers: CONSUMER_EXPECTATIONS_V1,
};

export const SCA_BROKER_SCHEMA_MANIFEST_SHA256_V1 = sha256(
  canonicalJson(SCHEMA_MANIFEST_PREIMAGE_V1)
);

export const SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V1 = Object.freeze({
  ...SCHEMA_MANIFEST_PREIMAGE_V1,
  manifest_sha256: SCA_BROKER_SCHEMA_MANIFEST_SHA256_V1,
});

const SCHEMA_DEFINITIONS_V2 = [
  ...SCHEMA_DEFINITIONS_V1,
  {
    export_name: "ScaBrokerJobProgressV1Schema",
    schema_id: "penny.sca-broker-job-progress.v1",
    schema: ScaBrokerJobProgressV1Schema,
  },
  {
    export_name: "ScaBrokerExecuteAcceptedResultV2Schema",
    schema_id: "penny.sca-broker-execute-accepted-result.v2",
    schema: ScaBrokerExecuteAcceptedResultV2Schema,
  },
  {
    export_name: "ScaBrokerPollResultV2Schema",
    schema_id: "penny.sca-broker-poll-result.v2",
    schema: ScaBrokerPollResultV2Schema,
  },
  {
    export_name: "ScaBrokerSchemaDigestManifestV2Schema",
    schema_id: "penny.sca-broker-schema-digest-manifest.v2",
    schema: ScaBrokerSchemaDigestManifestV2Schema,
  },
] satisfies readonly {
  readonly export_name: string;
  readonly schema_id: string;
  readonly schema: TSchema;
}[];

const CONSUMER_EXPECTATIONS_V2 = [
  {
    module_path: "apps/sca-service/src/contracts.ts",
    integration: "generated_digest_lock_v2",
    canonical_source: "apps/orchestration/src/sca/broker-contracts.ts",
    generated_bundle_export: "SCA_BROKER_SCHEMA_BUNDLE_V2",
    manifest_export: "SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V2",
  },
  {
    module_path: ".pi/extensions/sca/src/contracts.ts",
    integration: "generated_digest_lock_v2",
    canonical_source: "apps/orchestration/src/sca/broker-contracts.ts",
    generated_bundle_export: "SCA_BROKER_SCHEMA_BUNDLE_V2",
    manifest_export: "SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V2",
  },
] as const;

const SCHEMA_MANIFEST_PREIMAGE_V2 = {
  schema_id: "penny.sca-broker-schema-digest-manifest.v2",
  schema_version: 2,
  canonical_source: "apps/orchestration/src/sca/broker-contracts.ts",
  generated_bundle_export: "SCA_BROKER_SCHEMA_BUNDLE_V2",
  semantic_profile: "penny.sca-broker-semantics.v2",
  semantic_limits: {
    ...SCA_BROKER_CONTRACT_LIMITS_V1,
    max_progress_sequence: SCA_BROKER_PROGRESS_LIMITS_V1.max_sequence,
    max_progress_work_units: SCA_BROKER_PROGRESS_LIMITS_V1.max_work_units,
  },
  tool_operation_map: TOOL_OPERATION_ENTRIES,
  schema_digests: SCHEMA_DEFINITIONS_V2.map((definition) => ({
    export_name: definition.export_name,
    schema_id: definition.schema_id,
    sha256: scaBrokerSchemaSha256(definition.schema),
  })),
  consumers: CONSUMER_EXPECTATIONS_V2,
};

export const SCA_BROKER_SCHEMA_MANIFEST_SHA256 = sha256(canonicalJson(SCHEMA_MANIFEST_PREIMAGE_V2));

export const SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V2 = Object.freeze({
  ...SCHEMA_MANIFEST_PREIMAGE_V2,
  manifest_sha256: SCA_BROKER_SCHEMA_MANIFEST_SHA256,
});

export interface ScaBrokerScopeBindingV1 {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
}

export interface ScaBrokerJobBindingV1 extends ScaBrokerScopeBindingV1 {
  readonly job_id: string;
  readonly attempt: number;
  readonly idempotency_key: string;
  readonly tool_name: ScaBrokerToolName;
  readonly operation: ScaBrokerOperationKind;
}

export class ScaBrokerContractError extends Error {
  readonly code: ScaBrokerErrorCode;
  readonly issues: readonly string[];

  constructor(code: ScaBrokerErrorCode, label: string, issues: readonly string[]) {
    super(`${label} failed validation (${code}): ${issues.join("; ")}`);
    this.name = "ScaBrokerContractError";
    this.code = code;
    this.issues = issues;
  }
}

function fail(label: string, issue: string, code: ScaBrokerErrorCode = "invalid_request"): never {
  throw new ScaBrokerContractError(code, label, [issue]);
}

function assertBoundedJson(value: unknown, label: string): void {
  const pending: {
    readonly value: unknown;
    readonly depth: number;
    readonly exiting: boolean;
  }[] = [{ value, depth: 0, exiting: false }];
  const active = new Set<object>();
  let nodes = 0;
  let approximateBytes = 0;

  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) break;
    const current = frame.value;
    if (frame.exiting) {
      if (current !== null && typeof current === "object") active.delete(current);
      continue;
    }
    nodes += 1;
    if (nodes > MAX_JSON_NODES) fail(label, "JSON value has too many nodes");
    if (frame.depth > MAX_JSON_DEPTH) fail(label, "JSON value is too deeply nested");

    if (current === null || typeof current === "boolean") {
      approximateBytes += 8;
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail(label, "numbers must be finite");
      approximateBytes += 24;
      continue;
    }
    if (typeof current === "string") {
      approximateBytes += Buffer.byteLength(current, "utf8") + 2;
      if (approximateBytes > SCA_BROKER_CONTRACT_LIMITS_V1.max_request_bytes) {
        fail(label, "JSON value exceeds the byte limit");
      }
      continue;
    }
    if (typeof current !== "object") fail(label, "value must be JSON-compatible");
    if (active.has(current)) fail(label, "cyclic JSON values are not accepted");
    active.add(current);
    pending.push({ value: current, depth: frame.depth, exiting: true });

    if (Array.isArray(current)) {
      for (const item of current) {
        pending.push({ value: item, depth: frame.depth + 1, exiting: false });
      }
      continue;
    }

    if (
      Object.getPrototypeOf(current) !== Object.prototype &&
      Object.getPrototypeOf(current) !== null
    ) {
      fail(label, "value must contain only plain JSON objects");
    }
    for (const [key, entry] of Object.entries(current)) {
      approximateBytes += Buffer.byteLength(key, "utf8") + 4;
      pending.push({ value: entry, depth: frame.depth + 1, exiting: false });
    }
    if (approximateBytes > SCA_BROKER_CONTRACT_LIMITS_V1.max_request_bytes) {
      fail(label, "JSON value exceeds the byte limit");
    }
  }
}

function parseContract<TSchemaValue extends TSchema>(
  schema: TSchemaValue,
  value: unknown,
  label: string
): Static<TSchemaValue> {
  try {
    assertBoundedJson(value, label);
    const parsed = validateContract(schema, value, label);
    if (
      Buffer.byteLength(canonicalJson(parsed), "utf8") >
      SCA_BROKER_CONTRACT_LIMITS_V1.max_request_bytes
    ) {
      fail(label, "canonical JSON exceeds the byte limit");
    }
    return parsed;
  } catch (error) {
    if (error instanceof ScaBrokerContractError) throw error;
    fail(label, error instanceof Error ? error.message : "schema validation failed");
  }
}

function assertSafeText(value: string, label: string): void {
  if (
    value !== value.normalize("NFC") ||
    value.trim().length === 0 ||
    value.includes("\r") ||
    value.includes("\n") ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f))
      );
    }) ||
    Buffer.byteLength(value, "utf8") > SAFE_TEXT_MAX_BYTES
  ) {
    fail(label, "text must be normalized, single-line, non-empty, and within its byte limit");
  }
}

function assertBrokerOpaqueId(value: string, label: string): void {
  try {
    assertOpaqueId(value, label);
  } catch (error) {
    fail(label, error instanceof Error ? error.message : "opaque ID is unsafe");
  }
}

function timestampNanoseconds(value: string, label: string): bigint {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (match === null) fail(label, "timestamp must be canonical RFC3339 UTC");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maximumDay = monthDays[month - 1];
  if (
    maximumDay === undefined ||
    day < 1 ||
    day > maximumDay ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    fail(label, "timestamp contains an invalid calendar value");
  }
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute, second);
  return BigInt(milliseconds) * 1_000_000n + BigInt(fraction.padEnd(9, "0"));
}

function assertDeadlineWindow(
  requestedAt: string,
  deadlineAt: string,
  timeoutMs: number,
  label: string
): void {
  const start = timestampNanoseconds(requestedAt, `${label}.requested_at`);
  const deadline = timestampNanoseconds(deadlineAt, `${label}.deadline_at`);
  const windowNanoseconds = deadline - start;
  if (windowNanoseconds <= 0n) fail(label, "deadline must be after the request timestamp");
  if (windowNanoseconds < BigInt(timeoutMs) * 1_000_000n) {
    fail(label, "deadline window must cover the requested timeout");
  }
  if (
    windowNanoseconds >
    BigInt(SCA_BROKER_CONTRACT_LIMITS_V1.max_deadline_window_ms) * 1_000_000n
  ) {
    fail(label, "deadline window exceeds the safe maximum");
  }
}

function assertObservedWithinRequestWindow(
  observedAt: string,
  requestedAt: string,
  deadlineAt: string,
  label: string
): void {
  const observed = timestampNanoseconds(observedAt, `${label}.observed_at`);
  const requested = timestampNanoseconds(requestedAt, `${label}.requested_at`);
  const deadline = timestampNanoseconds(deadlineAt, `${label}.deadline_at`);
  if (observed < requested) fail(label, "observed_at precedes the request");
  if (observed > deadline) fail(label, "observed_at exceeds the request deadline");
}

function assertScopeIdentity(value: ScaBrokerScopeBindingV1, label: string): void {
  assertBrokerOpaqueId(value.tenant_id, `${label}.tenant_id`);
  assertBrokerOpaqueId(value.project_id, `${label}.project_id`);
  assertBrokerOpaqueId(value.run_id, `${label}.run_id`);
}

function assertJobIdentity(value: ScaBrokerJobBindingV1, label: string): void {
  assertScopeIdentity(value, label);
  assertBrokerOpaqueId(value.job_id, `${label}.job_id`);
  assertBrokerOpaqueId(value.idempotency_key, `${label}.idempotency_key`);
  assertToolOperation(value.tool_name, value.operation, label);
}

function assertScopeBinding(
  actual: ScaBrokerScopeBindingV1,
  expected: ScaBrokerScopeBindingV1,
  label: string
): void {
  if (
    actual.tenant_id !== expected.tenant_id ||
    actual.project_id !== expected.project_id ||
    actual.run_id !== expected.run_id
  ) {
    fail(label, "tenant, project, and run bindings must match the originating request");
  }
}

function assertJobBinding(
  actual: ScaBrokerJobBindingV1,
  expected: ScaBrokerJobBindingV1,
  label: string
): void {
  assertScopeBinding(actual, expected, label);
  if (
    actual.job_id !== expected.job_id ||
    actual.attempt !== expected.attempt ||
    actual.idempotency_key !== expected.idempotency_key ||
    actual.tool_name !== expected.tool_name ||
    actual.operation !== expected.operation
  ) {
    fail(label, "job, attempt, idempotency, tool, and operation bindings must match");
  }
}

function progressPhaseRank(phase: ScaBrokerJobProgressV1["phase"]): number {
  switch (phase) {
    case "accepted":
      return 0;
    case "executing":
      return 1;
    case "materializing_output":
      return 2;
  }
}

function assertProgressSemantics(progress: ScaBrokerJobProgressV1, label: string): void {
  if (progress.phase === "accepted") {
    if (
      progress.sequence !== 0 ||
      progress.work_units !== 0 ||
      progress.output_bytes !== 0 ||
      progress.result_items !== 0
    ) {
      fail(label, "accepted progress must be the zero-valued sequence baseline");
    }
    return;
  }
  if (progress.sequence < 1) {
    fail(label, "active progress requires a positive sequence");
  }
  if (
    progress.phase === "executing" &&
    progress.sequence > 1 &&
    progress.work_units === 0 &&
    progress.output_bytes === 0 &&
    progress.result_items === 0
  ) {
    fail(label, "advanced executing progress requires a broker-observed work milestone");
  }
  if (
    progress.phase === "materializing_output" &&
    progress.output_bytes === 0 &&
    progress.result_items === 0
  ) {
    fail(label, "output progress requires broker-owned output bytes or result items");
  }
}

function operationForTool(toolName: ScaBrokerToolName): ScaBrokerOperationKind {
  switch (toolName) {
    case "sca_source_query":
      return "source_query";
    case "sca_graph_query":
      return "graph_query";
    case "sca_application_test":
      return "application_test";
  }
}

function assertToolOperation(
  toolName: ScaBrokerToolName,
  operation: ScaBrokerOperationKind,
  label: string
): void {
  if (operationForTool(toolName) !== operation) {
    fail(label, `tool '${toolName}' cannot request operation '${operation}'`);
  }
}

function assertRepositoryPath(value: string, label: string): void {
  const segments = value.split("/");
  if (
    value !== value.normalize("NFC") ||
    Buffer.byteLength(value, "utf8") > REPOSITORY_PATH_MAX_BYTES ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/.test(value) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    fail(label, "selector path must be a normalized repository-relative path");
  }
}

function assertSelector(selector: ScaBrokerRepositorySelectorV1, label: string): void {
  assertRepositoryPath(selector.path, `${label}.path`);
  if (
    selector.line_range !== null &&
    selector.line_range.end_line_exclusive <= selector.line_range.start_line
  ) {
    fail(label, "line range must be non-empty and increasing");
  }
  if (selector.symbol !== null) assertSafeText(selector.symbol, `${label}.symbol`);
}

function assertQueryInput(
  input: {
    readonly query_id: string;
    readonly selectors: readonly ScaBrokerRepositorySelectorV1[];
    readonly parameters: readonly ScaBrokerTypedParameterV1[];
  },
  label: string
): void {
  assertBrokerOpaqueId(input.query_id, `${label}.query_id`);
  const selectorKeys = new Set<string>();
  for (const [index, selector] of input.selectors.entries()) {
    assertSelector(selector, `${label}.selectors[${index}]`);
    const key = canonicalJson(selector);
    if (selectorKeys.has(key)) fail(label, "selectors must be unique");
    selectorKeys.add(key);
  }
  const parameterNames = new Set<string>();
  for (const [index, parameter] of input.parameters.entries()) {
    if (parameterNames.has(parameter.name)) fail(label, "parameter names must be unique");
    parameterNames.add(parameter.name);
    if (parameter.value.kind === "literal") {
      assertSafeText(parameter.value.value, `${label}.parameters[${index}].value`);
    }
  }
}

function canonicalArtifactRef(
  value: CurrentArtifactRef,
  runId: string,
  label: string
): CurrentArtifactRef {
  let ref: CurrentArtifactRef;
  try {
    ref = currentScaArtifactRef(value, label);
  } catch (error) {
    fail(label, error instanceof Error ? error.message : "artifact ref is not canonical");
  }
  if (ref.run_id !== runId) fail(label, "artifact ref must belong to the bound run");
  if (!Number.isSafeInteger(ref.byte_length)) fail(label, "artifact byte length must be safe");
  return ref;
}

function assertArtifactRefs(
  refs: readonly CurrentArtifactRef[],
  runId: string,
  label: string
): void {
  const artifactIds = new Set<string>();
  let previousArtifactId: string | undefined;
  for (const [index, value] of refs.entries()) {
    const ref = canonicalArtifactRef(value, runId, `${label}[${index}]`);
    if (artifactIds.has(ref.artifact_id)) fail(label, "artifact refs must be unique");
    if (previousArtifactId !== undefined && previousArtifactId > ref.artifact_id) {
      fail(label, "artifact refs must be ordered by artifact_id");
    }
    artifactIds.add(ref.artifact_id);
    previousArtifactId = ref.artifact_id;
  }
}

function refsEqual(
  first: readonly CurrentArtifactRef[],
  second: readonly CurrentArtifactRef[]
): boolean {
  return canonicalJson(first) === canonicalJson(second);
}

function assertContainsExactRef(
  refs: readonly CurrentArtifactRef[],
  expected: CurrentArtifactRef,
  label: string
): void {
  if (!refs.some((ref) => canonicalJson(ref) === canonicalJson(expected))) {
    fail(label, "declared input refs do not contain the exact operation artifact ref");
  }
}

function assertExecutionArtifactBindings(request: ScaBrokerExecuteRequestV1): void {
  const snapshot = canonicalArtifactRef(
    request.source_snapshot_ref,
    request.run_id,
    "SCA broker execute request source_snapshot_ref"
  );
  if (snapshot.kind !== "source-snapshot") {
    fail("SCA broker execute request", "source_snapshot_ref must identify a source-snapshot");
  }
  canonicalArtifactRef(request.config_ref, request.run_id, "SCA broker execute request config_ref");
  assertArtifactRefs(request.input_refs, request.run_id, "SCA broker execute request input_refs");

  const input = request.operation_input;
  if (input.kind !== request.operation) {
    fail("SCA broker execute request", "operation_input kind must match operation");
  }
  if (input.kind === "source_query") {
    assertQueryInput(input, "SCA broker source query input");
    return;
  }
  if (input.kind === "graph_query") {
    const graphRef = canonicalArtifactRef(
      input.graph_ref,
      request.run_id,
      "SCA broker graph query graph_ref"
    );
    if (graphRef.kind !== "sca-graph") {
      fail("SCA broker graph query input", "graph_ref must identify an sca-graph artifact");
    }
    assertContainsExactRef(request.input_refs, graphRef, "SCA broker graph query input");
    assertQueryInput(input, "SCA broker graph query input");
    return;
  }

  const executionPlanRef = canonicalArtifactRef(
    input.execution_plan_ref,
    request.run_id,
    "SCA broker application test execution_plan_ref"
  );
  const policyRef = canonicalArtifactRef(
    input.policy_ref,
    request.run_id,
    "SCA broker application test policy_ref"
  );
  if (executionPlanRef.kind !== "sca-execution-plan") {
    fail(
      "SCA broker application test input",
      "execution_plan_ref must identify an sca-execution-plan artifact"
    );
  }
  if (policyRef.kind !== "sca-execution-policy") {
    fail(
      "SCA broker application test input",
      "policy_ref must identify an sca-execution-policy artifact"
    );
  }
  if (
    request.input_refs.length !== 2 ||
    !request.input_refs.some((ref) => canonicalJson(ref) === canonicalJson(executionPlanRef)) ||
    !request.input_refs.some((ref) => canonicalJson(ref) === canonicalJson(policyRef))
  ) {
    fail(
      "SCA broker application test input",
      "input_refs must contain only the exact execution plan and policy refs"
    );
  }
}

function assertTypedError(error: ScaBrokerTypedErrorV1, label: string): void {
  assertSafeText(error.message, `${label}.message`);
}

function assertTerminalResourceAttestation(
  outputRefs: readonly CurrentArtifactRef[],
  resultItemCount: number,
  limits: ScaBrokerRequestLimitsV1,
  label: string
): void {
  let declaredOutputBytes = 0n;
  for (const ref of outputRefs) {
    declaredOutputBytes += BigInt(ref.byte_length);
  }
  if (declaredOutputBytes > BigInt(limits.max_output_bytes)) {
    fail(label, "total declared output_ref byte_length exceeds limits.max_output_bytes");
  }
  if (resultItemCount > limits.max_result_items) {
    fail(label, "result_item_count exceeds limits.max_result_items");
  }
  if (outputRefs.length === 0 && resultItemCount !== 0) {
    fail(label, "result_item_count must be zero when no output_refs are declared");
  }
}

function assertTerminalTruth(
  status: ScaBrokerTerminalStatus,
  outputRefs: readonly CurrentArtifactRef[],
  failure: ScaBrokerTypedErrorV1 | null,
  partial: boolean,
  truncated: boolean,
  label: string
): void {
  const hasOutputs = outputRefs.length > 0;
  if (status === "succeeded") {
    if (failure !== null || !hasOutputs || partial || truncated) {
      fail(label, "succeeded requires output, no failure, and no partial or truncation flags");
    }
    return;
  }
  if (failure === null) fail(label, `${status} requires a typed failure`);
  assertTypedError(failure, `${label}.failure`);

  if (status === "timed_out") {
    if (failure.code !== "timeout" || partial !== hasOutputs || truncated) {
      fail(label, "timed_out requires timeout, truthful partial output, and no truncation");
    }
    return;
  }
  if (status === "cancelled") {
    if (failure.code !== "cancelled" || partial !== hasOutputs || truncated) {
      fail(label, "cancelled requires cancelled, truthful partial output, and no truncation");
    }
    return;
  }
  if (failure.code === "timeout" || failure.code === "cancelled") {
    fail(label, "timeout and cancelled failures require their matching terminal status");
  }
  if (failure.code === "output_truncated") {
    if (!hasOutputs || !partial || !truncated) {
      fail(label, "output_truncated requires retained partial output and truncation=true");
    }
    return;
  }
  if (failure.code === "service_unavailable" && hasOutputs) {
    fail(label, "service_unavailable cannot claim output");
  }
  if (truncated || partial !== hasOutputs) {
    fail(label, "failed output must use truthful partial and truncation flags");
  }
}

export function validateScaBrokerJobProgressV1(
  value: unknown,
  expected?: ScaBrokerJobBindingV1 & { readonly request_sha256: string }
): ScaBrokerJobProgressV1 {
  const progress = parseContract(ScaBrokerJobProgressV1Schema, value, "SCA broker job progress");
  assertJobIdentity(progress, "SCA broker job progress");
  assertProgressSemantics(progress, "SCA broker job progress");
  if (expected !== undefined) {
    assertJobBinding(progress, expected, "SCA broker job progress");
    if (progress.request_sha256 !== expected.request_sha256) {
      fail("SCA broker job progress", "request_sha256 must bind the exact accepted job");
    }
  }
  return progress;
}

export type ScaBrokerProgressDisposition = "unchanged" | "advanced";

export function classifyScaBrokerJobProgressV1(
  previousValue: unknown,
  candidateValue: unknown
): ScaBrokerProgressDisposition {
  const previous = validateScaBrokerJobProgressV1(previousValue);
  const candidate = validateScaBrokerJobProgressV1(candidateValue);
  assertJobBinding(candidate, previous, "SCA broker job progress");
  if (candidate.request_sha256 !== previous.request_sha256) {
    fail("SCA broker job progress", "request_sha256 changed across progress snapshots");
  }
  if (candidate.sequence < previous.sequence) {
    fail("SCA broker job progress", "progress sequence regressed");
  }
  if (
    candidate.work_units < previous.work_units ||
    candidate.output_bytes < previous.output_bytes ||
    candidate.result_items < previous.result_items ||
    progressPhaseRank(candidate.phase) < progressPhaseRank(previous.phase)
  ) {
    fail("SCA broker job progress", "progress counters or phase regressed");
  }
  if (candidate.sequence === previous.sequence) {
    if (canonicalJson(candidate) !== canonicalJson(previous)) {
      fail("SCA broker job progress", "an unchanged sequence must have identical metadata");
    }
    return "unchanged";
  }
  if (
    candidate.work_units === previous.work_units &&
    candidate.output_bytes === previous.output_bytes &&
    candidate.result_items === previous.result_items &&
    candidate.phase === previous.phase
  ) {
    fail("SCA broker job progress", "a higher sequence requires substantive broker progress");
  }
  return "advanced";
}

export function validateScaBrokerTypedErrorV1(value: unknown): ScaBrokerTypedErrorV1 {
  const error = parseContract(ScaBrokerTypedErrorV1Schema, value, "SCA broker typed error");
  assertTypedError(error, "SCA broker typed error");
  return error;
}

export function validateScaBrokerCapabilityRequestV1(value: unknown): ScaBrokerCapabilityRequestV1 {
  const request = parseContract(
    ScaBrokerCapabilityRequestV1Schema,
    value,
    "SCA broker capability request"
  );
  assertScopeIdentity(request, "SCA broker capability request");
  assertBrokerOpaqueId(request.request_id, "SCA broker capability request.request_id");
  assertToolOperation(request.tool_name, request.operation, "SCA broker capability request");
  assertDeadlineWindow(
    request.requested_at,
    request.deadline_at,
    request.timeout_ms,
    "SCA broker capability request"
  );
  return request;
}

export function validateScaBrokerCapabilityResultV1(
  value: unknown,
  expected: ScaBrokerCapabilityRequestV1
): ScaBrokerCapabilityResultV1 {
  const result = parseContract(
    ScaBrokerCapabilityResultV1Schema,
    value,
    "SCA broker capability result"
  );
  assertScopeIdentity(result, "SCA broker capability result");
  assertBrokerOpaqueId(result.request_id, "SCA broker capability result.request_id");
  assertToolOperation(result.tool_name, result.operation, "SCA broker capability result");
  const request = validateScaBrokerCapabilityRequestV1(expected);
  assertScopeBinding(result, request, "SCA broker capability result");
  if (
    result.request_id !== request.request_id ||
    result.tool_name !== request.tool_name ||
    result.operation !== request.operation
  ) {
    fail("SCA broker capability result", "request, tool, and operation bindings must match");
  }
  assertObservedWithinRequestWindow(
    result.observed_at,
    request.requested_at,
    request.deadline_at,
    "SCA broker capability result"
  );
  if (result.status === "available") {
    if (result.limits === null || result.error !== null) {
      fail("SCA broker capability result", "available requires limits and no error");
    }
  } else {
    if (result.limits !== null || result.error === null) {
      fail("SCA broker capability result", "unavailable requires an error and no limits");
    }
    assertTypedError(result.error, "SCA broker capability result.error");
    if (
      result.error.code !== "service_unavailable" &&
      result.error.code !== "unsupported_operation" &&
      result.error.code !== "unauthorized"
    ) {
      fail(
        "SCA broker capability result",
        "unavailable permits only service_unavailable, unsupported_operation, or unauthorized"
      );
    }
  }
  return result;
}

export function validateScaBrokerExecuteRequestV1(value: unknown): ScaBrokerExecuteRequestV1 {
  const request = parseContract(
    ScaBrokerExecuteRequestV1Schema,
    value,
    "SCA broker execute request"
  );
  assertJobIdentity(request, "SCA broker execute request");
  assertDeadlineWindow(
    request.submitted_at,
    request.deadline_at,
    request.limits.timeout_ms,
    "SCA broker execute request"
  );
  assertExecutionArtifactBindings(request);
  return request;
}

export function scaBrokerExecuteRequestSha256(value: unknown): string {
  return sha256(canonicalJson(validateScaBrokerExecuteRequestV1(value)));
}

export function validateScaBrokerExecuteAcceptedResultV1(
  value: unknown,
  expected?: ScaBrokerExecuteRequestV1
): ScaBrokerExecuteAcceptedResultV1 {
  const result = parseContract(
    ScaBrokerExecuteAcceptedResultV1Schema,
    value,
    "SCA broker execute accepted result"
  );
  assertJobIdentity(result, "SCA broker execute accepted result");
  const acceptedAt = timestampNanoseconds(
    result.accepted_at,
    "SCA broker execute accepted result.accepted_at"
  );
  if (expected !== undefined) {
    const request = validateScaBrokerExecuteRequestV1(expected);
    assertJobBinding(result, request, "SCA broker execute accepted result");
    if (result.request_sha256 !== scaBrokerExecuteRequestSha256(request)) {
      fail("SCA broker execute accepted result", "request_sha256 must bind the exact request");
    }
    const submittedAt = timestampNanoseconds(
      request.submitted_at,
      "SCA broker execute request.submitted_at"
    );
    const deadlineAt = timestampNanoseconds(
      request.deadline_at,
      "SCA broker execute request.deadline_at"
    );
    if (acceptedAt < submittedAt || acceptedAt > deadlineAt) {
      fail("SCA broker execute accepted result", "accepted_at falls outside the request window");
    }
  }
  return result;
}

export function validateScaBrokerExecuteAcceptedResultV2(
  value: unknown,
  expected?: ScaBrokerExecuteRequestV1
): ScaBrokerExecuteAcceptedResultV2 {
  const result = parseContract(
    ScaBrokerExecuteAcceptedResultV2Schema,
    value,
    "SCA broker execute accepted result v2"
  );
  const legacyProjection = {
    schema_id: "penny.sca-broker-execute-accepted-result.v1",
    schema_version: 1,
    tenant_id: result.tenant_id,
    project_id: result.project_id,
    run_id: result.run_id,
    job_id: result.job_id,
    attempt: result.attempt,
    idempotency_key: result.idempotency_key,
    tool_name: result.tool_name,
    operation: result.operation,
    status: result.status,
    request_sha256: result.request_sha256,
    accepted_at: result.accepted_at,
  } as const;
  validateScaBrokerExecuteAcceptedResultV1(legacyProjection, expected);
  const progress = validateScaBrokerJobProgressV1(result.progress, result);
  if (progress.phase !== "accepted") {
    fail("SCA broker execute accepted result v2", "accepted result requires baseline progress");
  }
  return result;
}

export function validateScaBrokerExecuteAcceptedResult(
  value: unknown,
  expected?: ScaBrokerExecuteRequestV1
): ScaBrokerExecuteAcceptedResult {
  if (
    typeof value === "object" &&
    value !== null &&
    "schema_id" in value &&
    value.schema_id === "penny.sca-broker-execute-accepted-result.v2"
  ) {
    return validateScaBrokerExecuteAcceptedResultV2(value, expected);
  }
  return validateScaBrokerExecuteAcceptedResultV1(value, expected);
}

export function validateScaBrokerPollRequestV1(value: unknown): ScaBrokerPollRequestV1 {
  const request = parseContract(ScaBrokerPollRequestV1Schema, value, "SCA broker poll request");
  assertJobIdentity(request, "SCA broker poll request");
  assertDeadlineWindow(
    request.requested_at,
    request.deadline_at,
    request.poll_timeout_ms,
    "SCA broker poll request"
  );
  return request;
}

export function validateScaBrokerReceiptV1(
  value: unknown,
  expected?: ScaBrokerExecuteRequestV1
): ScaBrokerReceiptV1 {
  const receipt = parseContract(ScaBrokerReceiptV1Schema, value, "SCA broker receipt");
  assertJobIdentity(receipt, "SCA broker receipt");
  assertBrokerOpaqueId(receipt.receipt_id, "SCA broker receipt.receipt_id");
  const sourceSnapshotRef = canonicalArtifactRef(
    receipt.source_snapshot_ref,
    receipt.run_id,
    "SCA broker receipt source_snapshot_ref"
  );
  if (sourceSnapshotRef.kind !== "source-snapshot") {
    fail("SCA broker receipt", "source_snapshot_ref must identify a source-snapshot");
  }
  canonicalArtifactRef(receipt.config_ref, receipt.run_id, "SCA broker receipt config_ref");
  assertArtifactRefs(receipt.input_refs, receipt.run_id, "SCA broker receipt input_refs");
  assertArtifactRefs(receipt.output_refs, receipt.run_id, "SCA broker receipt output_refs");
  assertTerminalResourceAttestation(
    receipt.output_refs,
    receipt.result_item_count,
    receipt.limits,
    "SCA broker receipt"
  );
  const acceptedAt = timestampNanoseconds(receipt.accepted_at, "SCA broker receipt.accepted_at");
  const terminalAt = timestampNanoseconds(receipt.terminal_at, "SCA broker receipt.terminal_at");
  if (terminalAt < acceptedAt) fail("SCA broker receipt", "terminal_at precedes accepted_at");
  assertTerminalTruth(
    receipt.terminal_status,
    receipt.output_refs,
    receipt.failure,
    receipt.partial,
    receipt.truncated,
    "SCA broker receipt"
  );
  if (expected !== undefined) {
    const request = validateScaBrokerExecuteRequestV1(expected);
    assertJobBinding(receipt, request, "SCA broker receipt");
    if (
      receipt.request_sha256 !== scaBrokerExecuteRequestSha256(request) ||
      canonicalJson(receipt.source_snapshot_ref) !== canonicalJson(request.source_snapshot_ref) ||
      canonicalJson(receipt.config_ref) !== canonicalJson(request.config_ref) ||
      !refsEqual(receipt.input_refs, request.input_refs)
    ) {
      fail("SCA broker receipt", "receipt must bind the exact request and declared inputs");
    }
    if (canonicalJson(receipt.limits) !== canonicalJson(request.limits)) {
      fail("SCA broker receipt", "receipt limits must match the exact request limits");
    }
    const submittedAt = timestampNanoseconds(
      request.submitted_at,
      "SCA broker execute request.submitted_at"
    );
    const deadlineAt = timestampNanoseconds(
      request.deadline_at,
      "SCA broker execute request.deadline_at"
    );
    if (acceptedAt < submittedAt || acceptedAt > deadlineAt) {
      fail("SCA broker receipt", "accepted_at falls outside the request window");
    }
    // The execute deadline is an admission window. Once accepted, productive execution may run
    // beyond it; `limits.timeout_ms` is interpreted by live supervisors as renewable inactivity.
  }
  return receipt;
}

export function validateScaBrokerPollResultV1(
  value: unknown,
  expected: ScaBrokerPollRequestV1,
  expectedExecute?: ScaBrokerExecuteRequestV1
): ScaBrokerPollResultV1 {
  const result = parseContract(ScaBrokerPollResultV1Schema, value, "SCA broker poll result");
  assertJobIdentity(result, "SCA broker poll result");
  assertArtifactRefs(result.output_refs, result.run_id, "SCA broker poll result output_refs");
  const request = validateScaBrokerPollRequestV1(expected);
  assertJobBinding(result, request, "SCA broker poll result");
  if (result.request_sha256 !== request.request_sha256) {
    fail("SCA broker poll result", "request_sha256 must match the poll request");
  }
  assertObservedWithinRequestWindow(
    result.observed_at,
    request.requested_at,
    request.deadline_at,
    "SCA broker poll result"
  );
  if (result.status === "accepted" || result.status === "running") {
    if (
      result.output_refs.length !== 0 ||
      result.result_item_count !== 0 ||
      result.failure !== null ||
      result.receipt !== null ||
      result.partial ||
      result.truncated
    ) {
      fail(
        "SCA broker poll result",
        "nonterminal status requires zero result_item_count and cannot claim failure, output, or receipt"
      );
    }
    return result;
  }
  if (result.receipt === null) {
    fail("SCA broker poll result", "terminal status requires a receipt");
  }
  if (expectedExecute === undefined) {
    fail("SCA broker poll result", "terminal result requires the exact execute request context");
  }
  const executeRequest = validateScaBrokerExecuteRequestV1(expectedExecute);
  assertJobBinding(request, executeRequest, "SCA broker poll request");
  if (request.request_sha256 !== scaBrokerExecuteRequestSha256(executeRequest)) {
    fail("SCA broker poll request", "request_sha256 must bind the exact execute request");
  }
  const receipt = validateScaBrokerReceiptV1(result.receipt, executeRequest);
  assertJobBinding(receipt, result, "SCA broker poll result receipt");
  if (
    receipt.request_sha256 !== result.request_sha256 ||
    receipt.terminal_status !== result.status ||
    receipt.partial !== result.partial ||
    receipt.truncated !== result.truncated ||
    receipt.result_item_count !== result.result_item_count ||
    canonicalJson(receipt.failure) !== canonicalJson(result.failure) ||
    !refsEqual(receipt.output_refs, result.output_refs)
  ) {
    fail(
      "SCA broker poll result",
      "receipt must match terminal status, failure, outputs, and result_item_count"
    );
  }
  assertTerminalTruth(
    result.status,
    result.output_refs,
    result.failure,
    result.partial,
    result.truncated,
    "SCA broker poll result"
  );
  return result;
}

export function validateScaBrokerPollResultV2(
  value: unknown,
  expected: ScaBrokerPollRequestV1,
  expectedExecute?: ScaBrokerExecuteRequestV1
): ScaBrokerPollResultV2 {
  const result = parseContract(ScaBrokerPollResultV2Schema, value, "SCA broker poll result v2");
  const legacyProjection = {
    schema_id: "penny.sca-broker-poll-result.v1",
    schema_version: 1,
    tenant_id: result.tenant_id,
    project_id: result.project_id,
    run_id: result.run_id,
    job_id: result.job_id,
    attempt: result.attempt,
    idempotency_key: result.idempotency_key,
    tool_name: result.tool_name,
    operation: result.operation,
    request_sha256: result.request_sha256,
    status: result.status,
    partial: result.partial,
    truncated: result.truncated,
    output_refs: result.output_refs,
    result_item_count: result.result_item_count,
    failure: result.failure,
    receipt: result.receipt,
    observed_at: result.observed_at,
  } as const;
  validateScaBrokerPollResultV1(legacyProjection, expected, expectedExecute);
  if (expectedExecute === undefined) {
    fail("SCA broker poll result v2", "progress requires the exact execute request context");
  }
  const executeRequest = validateScaBrokerExecuteRequestV1(expectedExecute);
  const progress = validateScaBrokerJobProgressV1(result.progress, result);
  if (progress.request_sha256 !== scaBrokerExecuteRequestSha256(executeRequest)) {
    fail("SCA broker poll result v2", "progress must bind the exact execute request");
  }
  if (
    progress.output_bytes > executeRequest.limits.max_output_bytes ||
    progress.result_items > executeRequest.limits.max_result_items
  ) {
    fail("SCA broker poll result v2", "progress counters exceed the accepted request limits");
  }
  if (result.status === "accepted" && progress.phase !== "accepted") {
    fail("SCA broker poll result v2", "accepted status requires baseline progress");
  }
  if (result.status === "running" && progress.phase === "accepted") {
    fail("SCA broker poll result v2", "running status requires broker-observed active progress");
  }
  return result;
}

export function validateScaBrokerPollResult(
  value: unknown,
  expected: ScaBrokerPollRequestV1,
  expectedExecute?: ScaBrokerExecuteRequestV1
): ScaBrokerPollResult {
  if (
    typeof value === "object" &&
    value !== null &&
    "schema_id" in value &&
    value.schema_id === "penny.sca-broker-poll-result.v2"
  ) {
    return validateScaBrokerPollResultV2(value, expected, expectedExecute);
  }
  return validateScaBrokerPollResultV1(value, expected, expectedExecute);
}

export function validateScaBrokerCancelRequestV1(value: unknown): ScaBrokerCancelRequestV1 {
  const request = parseContract(ScaBrokerCancelRequestV1Schema, value, "SCA broker cancel request");
  assertJobIdentity(request, "SCA broker cancel request");
  assertDeadlineWindow(
    request.requested_at,
    request.deadline_at,
    request.timeout_ms,
    "SCA broker cancel request"
  );
  return request;
}

export function validateScaBrokerCancelResultV1(
  value: unknown,
  expected: ScaBrokerCancelRequestV1,
  expectedExecute?: ScaBrokerExecuteRequestV1
): ScaBrokerCancelResultV1 {
  const result = parseContract(ScaBrokerCancelResultV1Schema, value, "SCA broker cancel result");
  assertJobIdentity(result, "SCA broker cancel result");
  const request = validateScaBrokerCancelRequestV1(expected);
  assertJobBinding(result, request, "SCA broker cancel result");
  if (result.request_sha256 !== request.request_sha256) {
    fail("SCA broker cancel result", "request_sha256 must match the cancel request");
  }
  assertObservedWithinRequestWindow(
    result.observed_at,
    request.requested_at,
    request.deadline_at,
    "SCA broker cancel result"
  );
  if (result.outcome === "cancel_requested") {
    if (result.terminal_status !== null || result.receipt !== null || result.error !== null) {
      fail(
        "SCA broker cancel result",
        "cancel_requested is an acknowledgement, not a terminal claim"
      );
    }
    return result;
  }
  if (result.outcome === "rejected") {
    if (result.terminal_status !== null || result.receipt !== null || result.error === null) {
      fail("SCA broker cancel result", "rejected requires only a typed error");
    }
    assertTypedError(result.error, "SCA broker cancel result.error");
    if (
      result.error.code === "timeout" ||
      result.error.code === "cancelled" ||
      result.error.code === "output_truncated"
    ) {
      fail("SCA broker cancel result", "terminal job failures must be reported by a receipt");
    }
    return result;
  }
  if (result.terminal_status === null || result.receipt === null || result.error !== null) {
    fail("SCA broker cancel result", "terminal requires matching terminal status and receipt");
  }
  if (expectedExecute === undefined) {
    fail("SCA broker cancel result", "terminal result requires the exact execute request context");
  }
  const executeRequest = validateScaBrokerExecuteRequestV1(expectedExecute);
  assertJobBinding(request, executeRequest, "SCA broker cancel request");
  if (request.request_sha256 !== scaBrokerExecuteRequestSha256(executeRequest)) {
    fail("SCA broker cancel request", "request_sha256 must bind the exact execute request");
  }
  const receipt = validateScaBrokerReceiptV1(result.receipt, executeRequest);
  assertJobBinding(receipt, result, "SCA broker cancel result receipt");
  if (
    receipt.request_sha256 !== result.request_sha256 ||
    receipt.terminal_status !== result.terminal_status
  ) {
    fail("SCA broker cancel result", "terminal receipt request and status must match the result");
  }
  return result;
}

export type ScaBrokerIdempotencyDisposition = "distinct" | "duplicate";

export function classifyScaBrokerIdempotency(
  existingValue: unknown,
  candidateValue: unknown
): ScaBrokerIdempotencyDisposition {
  const existing = validateScaBrokerExecuteRequestV1(existingValue);
  const candidate = validateScaBrokerExecuteRequestV1(candidateValue);
  const sameScope =
    existing.tenant_id === candidate.tenant_id &&
    existing.project_id === candidate.project_id &&
    existing.run_id === candidate.run_id;
  if (!sameScope) return "distinct";
  const sameIdempotencyKey = existing.idempotency_key === candidate.idempotency_key;
  const sameJobAttempt =
    existing.job_id === candidate.job_id && existing.attempt === candidate.attempt;
  if (!sameIdempotencyKey && !sameJobAttempt) return "distinct";
  if (
    sameIdempotencyKey &&
    sameJobAttempt &&
    scaBrokerExecuteRequestSha256(existing) === scaBrokerExecuteRequestSha256(candidate)
  ) {
    return "duplicate";
  }
  fail(
    "SCA broker idempotency",
    "idempotency key or job attempt was reused with conflicting request identity or content",
    "conflict"
  );
}

export function validateScaBrokerSchemaDigestManifestV1(
  value: unknown
): ScaBrokerSchemaDigestManifestV1 {
  const manifest = parseContract(
    ScaBrokerSchemaDigestManifestV1Schema,
    value,
    "SCA broker schema digest manifest v1"
  );
  const preimage = {
    schema_id: manifest.schema_id,
    schema_version: manifest.schema_version,
    canonical_source: manifest.canonical_source,
    generated_bundle_export: manifest.generated_bundle_export,
    semantic_profile: manifest.semantic_profile,
    semantic_limits: manifest.semantic_limits,
    tool_operation_map: manifest.tool_operation_map,
    schema_digests: manifest.schema_digests,
    consumers: manifest.consumers,
  };
  if (sha256(canonicalJson(preimage)) !== manifest.manifest_sha256) {
    fail("SCA broker schema digest manifest", "manifest_sha256 does not match its preimage");
  }
  if (canonicalJson(manifest) !== canonicalJson(SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V1)) {
    fail(
      "SCA broker schema digest manifest",
      "manifest does not match the canonical schema bundle and consumer expectations"
    );
  }
  return manifest;
}

export function validateScaBrokerSchemaDigestManifestV2(
  value: unknown
): ScaBrokerSchemaDigestManifestV2 {
  const manifest = parseContract(
    ScaBrokerSchemaDigestManifestV2Schema,
    value,
    "SCA broker schema digest manifest v2"
  );
  const preimage = {
    schema_id: manifest.schema_id,
    schema_version: manifest.schema_version,
    canonical_source: manifest.canonical_source,
    generated_bundle_export: manifest.generated_bundle_export,
    semantic_profile: manifest.semantic_profile,
    semantic_limits: manifest.semantic_limits,
    tool_operation_map: manifest.tool_operation_map,
    schema_digests: manifest.schema_digests,
    consumers: manifest.consumers,
  };
  if (sha256(canonicalJson(preimage)) !== manifest.manifest_sha256) {
    fail("SCA broker schema digest manifest v2", "manifest_sha256 does not match its preimage");
  }
  if (canonicalJson(manifest) !== canonicalJson(SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V2)) {
    fail(
      "SCA broker schema digest manifest v2",
      "manifest does not match the canonical schema bundle and consumer expectations"
    );
  }
  return manifest;
}
