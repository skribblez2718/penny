import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  HostOperationArtifactContractV1Schema,
  HostOperationPolicyBindingV1Schema,
  InputArtifactsSchema,
  InvokeHostOperationDirectiveV1Schema,
  RunIdentitySchema,
  type ArtifactRef,
  type HostOperationArtifactContractV1,
  type HostOperationPolicyBindingV1,
  type InvokeHostOperationDirectiveV1,
  type JsonValue,
} from "../contracts.js";
import type { HostOperationCachedResultV1, HostOperationResultCacheV1 } from "./result-cache.js";
import {
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  SchemaIdSchema,
  Sha256Schema,
  assertOpaqueId,
  assertUnique,
  validateSkillSchema,
} from "../skill-contracts/common.js";

export const MAX_HOST_OPERATION_DECLARATIONS = 64 as const;
export const MAX_HOST_OPERATION_RECORD_BYTES = 1_048_576 as const;
export const MAX_HOST_OPERATION_RECEIPT_BYTES = 131_072 as const;
export const MAX_HOST_OPERATION_PROGRESS_METADATA_ENTRIES = 16 as const;

export const HostOperationCapabilityClassV1Schema = Type.Union([
  Type.Literal("artifact_store"),
  Type.Literal("registered_loopback_http"),
  Type.Literal("registered_export_root"),
]);
export type HostOperationCapabilityClassV1 = Static<typeof HostOperationCapabilityClassV1Schema>;

export const HostOperationLeaseProfileV1Schema = Type.Object(
  {
    profile_id: OpaqueIdSchema,
    profile_version: Type.Literal(1),
    profile_sha256: Sha256Schema,
    duration_ms: Type.Integer({ minimum: 2, maximum: 2_592_000_000 }),
    renew_after_ms: Type.Integer({ minimum: 1, maximum: 2_591_999_999 }),
    queue_inactivity_ms: Type.Integer({ minimum: 1, maximum: 2_592_000_000 }),
  },
  { additionalProperties: false }
);
export type HostOperationLeaseProfileV1 = Readonly<
  Static<typeof HostOperationLeaseProfileV1Schema>
>;

export function hostOperationLeaseProfileSha256(
  profile: Omit<HostOperationLeaseProfileV1, "profile_sha256">
): string {
  return sha256(canonicalJson(profile));
}

export const HostOperationDeclarationV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    operation_kind: OpaqueIdSchema,
    adapter_id: OpaqueIdSchema,
    request: HostOperationArtifactContractV1Schema,
    effect_protocol: Type.Optional(Type.Literal("request_intent_v1")),
    receipt_citing_result: Type.Optional(HostOperationArtifactContractV1Schema),
    result: HostOperationArtifactContractV1Schema,
    backend_binding_id: OpaqueIdSchema,
    capability_classes: Type.Array(HostOperationCapabilityClassV1Schema, {
      minItems: 1,
      maxItems: 3,
    }),
    lease_profile: HostOperationLeaseProfileV1Schema,
    operation_inactivity_ms: Type.Integer({ minimum: 1, maximum: 2_592_000_000 }),
    max_request_bytes: Type.Integer({ minimum: 1, maximum: 1_073_741_824 }),
    /** Optional for exact historical declarations; new adapters should bind both input limits. */
    max_input_artifacts: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_024 })),
    max_input_bytes: Type.Optional(Type.Integer({ minimum: 0, maximum: 4_294_967_296 })),
    /** Absent preserves historical declarations and denies adapter-specific output artifacts. */
    output_contracts: Type.Optional(
      Type.Array(HostOperationArtifactContractV1Schema, { maxItems: 1_023 })
    ),
    /**
     * Explicit ownership of the owner's per-operation result-artifact selection. Absent (or
     * `selected`) preserves the historical behavior: the owner selects the persisted adapter
     * result, platform result, and receipt as the current revision of their `(run, phase, branch,
     * kind)` coordinates. `unselected` persists those exact artifacts durably without selecting
     * them, so distinct per-item results of one kind under one state can coexist; the owning
     * playbook then resolves each exact result from its own operation/request binding rather than a
     * single selection. Adapter output artifacts keep their existing first-of-kind selection.
     */
    result_selection_policy: Type.Optional(
      Type.Union([Type.Literal("selected"), Type.Literal("unselected")])
    ),
    max_output_artifacts: Type.Integer({ minimum: 1, maximum: 1_024 }),
    max_output_bytes: Type.Integer({ minimum: 1, maximum: 4_294_967_296 }),
    max_progress_events: Type.Integer({ minimum: 1, maximum: 65_536 }),
    max_pre_acceptance_retries: Type.Integer({ minimum: 0, maximum: 64 }),
    recovery_semantics: Type.Union([
      Type.Literal("disposable_v1"),
      Type.Literal("journaled_remote_submission_v1"),
      Type.Literal("atomic_local_publication_v1"),
    ]),
    cancellation_semantics: Type.Union([
      Type.Literal("local_abort_only_v1"),
      Type.Literal("registered_remote_cancel_then_observe_v1"),
    ]),
  },
  { additionalProperties: false }
);
export type HostOperationDeclarationV1 = Readonly<Static<typeof HostOperationDeclarationV1Schema>>;

export const HostOperationAuthorityV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    max_active_per_run: Type.Literal(1),
    declarations: Type.Array(HostOperationDeclarationV1Schema, {
      minItems: 1,
      maxItems: MAX_HOST_OPERATION_DECLARATIONS,
    }),
  },
  { additionalProperties: false }
);
export type HostOperationAuthorityV1 = Readonly<Static<typeof HostOperationAuthorityV1Schema>>;

export function validateHostOperationDeclaration(value: unknown): HostOperationDeclarationV1 {
  const declaration = validateSkillSchema(
    HostOperationDeclarationV1Schema,
    value,
    "HostOperationDeclarationV1"
  );
  for (const [label, id] of [
    ["operation_kind", declaration.operation_kind],
    ["adapter_id", declaration.adapter_id],
    ["backend_binding_id", declaration.backend_binding_id],
    ["lease_profile.profile_id", declaration.lease_profile.profile_id],
  ] as const) {
    assertOpaqueId(id, `HostOperationDeclarationV1.${label}`);
  }
  assertUnique(
    declaration.capability_classes,
    `HostOperationDeclarationV1 '${declaration.operation_kind}' capability classes`
  );
  const outputContracts = declaration.output_contracts ?? [];
  assertUnique(
    outputContracts.map((contract) => contract.port_name),
    `HostOperationDeclarationV1 '${declaration.operation_kind}' output contract ports`
  );
  assertUnique(
    outputContracts.map(
      (contract) =>
        `${contract.artifact_kind}\u0000${contract.schema_id}\u0000${contract.schema_version_required}`
    ),
    `HostOperationDeclarationV1 '${declaration.operation_kind}' output contracts`
  );
  if (
    outputContracts.length + 1 + (declaration.receipt_citing_result === undefined ? 0 : 1) >
    declaration.max_output_artifacts
  ) {
    throw new Error(
      `HostOperationDeclarationV1 '${declaration.operation_kind}' output contracts exceed its artifact ceiling`
    );
  }
  if (
    (declaration.max_input_artifacts === undefined) !==
    (declaration.max_input_bytes === undefined)
  ) {
    throw new Error(
      `HostOperationDeclarationV1 '${declaration.operation_kind}' must bind both input limits or neither`
    );
  }
  if (
    declaration.receipt_citing_result !== undefined &&
    (declaration.receipt_citing_result.schema_id !== "penny.host-operation-receipted-result.v1" ||
      declaration.receipt_citing_result.schema_version_required !== 1)
  )
    throw new Error("host-operation receipt-citing result must use the fixed owner wrapper schema");
  const { profile_sha256: profileSha256, ...leaseProfileBody } = declaration.lease_profile;
  if (profileSha256 !== hostOperationLeaseProfileSha256(leaseProfileBody)) {
    throw new Error(
      `HostOperationDeclarationV1 '${declaration.operation_kind}' lease profile digest diverges`
    );
  }
  if (declaration.lease_profile.renew_after_ms >= declaration.lease_profile.duration_ms) {
    throw new Error(
      `HostOperationDeclarationV1 '${declaration.operation_kind}' renewal must precede expiry`
    );
  }
  if (declaration.lease_profile.queue_inactivity_ms > declaration.operation_inactivity_ms) {
    throw new Error(
      `HostOperationDeclarationV1 '${declaration.operation_kind}' queue inactivity interval exceeds operation inactivity interval`
    );
  }
  return declaration;
}

export function validateHostOperationAuthority(value: unknown): HostOperationAuthorityV1 {
  const authority = validateSkillSchema(
    HostOperationAuthorityV1Schema,
    value,
    "HostOperationAuthorityV1"
  );
  const declarations = authority.declarations.map(validateHostOperationDeclaration);
  assertUnique(
    declarations.map((declaration) => declaration.operation_kind),
    "HostOperationAuthorityV1 operation kinds"
  );
  return { ...authority, declarations };
}

export function hostOperationDeclarationSha256(declaration: HostOperationDeclarationV1): string {
  return sha256(canonicalJson(validateHostOperationDeclaration(declaration)));
}

/**
 * Whether the owner selects the persisted operation result as the current revision of its kind.
 * Historical declarations omit the policy, so an absent value stays `selected`.
 */
export function hostOperationResultIsSelected(declaration: HostOperationDeclarationV1): boolean {
  return (declaration.result_selection_policy ?? "selected") === "selected";
}

export function hostOperationPolicyBinding(
  declaration: HostOperationDeclarationV1,
  backendKeySha256: string
): HostOperationPolicyBindingV1 {
  const validated = validateHostOperationDeclaration(declaration);
  return validateSkillSchema(
    HostOperationPolicyBindingV1Schema,
    {
      schema_version: 1,
      declaration_sha256: hostOperationDeclarationSha256(validated),
      adapter_id: validated.adapter_id,
      backend_binding_id: validated.backend_binding_id,
      backend_key_sha256: backendKeySha256,
      lease_profile_id: validated.lease_profile.profile_id,
      lease_profile_sha256: validated.lease_profile.profile_sha256,
      operation_inactivity_ms: validated.operation_inactivity_ms,
    },
    "HostOperationPolicyBindingV1"
  );
}

export const HostOperationLeaseIdentityV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    backend_key_sha256: Sha256Schema,
    lease_id: OpaqueIdSchema,
    lease_epoch: Type.Integer({ minimum: 1 }),
    fencing_token_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type HostOperationLeaseIdentityV1 = Readonly<
  Static<typeof HostOperationLeaseIdentityV1Schema>
>;

const ReleasedHostOperationDispositionV1Schema = Type.Union([
  Type.Object(
    {
      outcome: Type.Literal("completed"),
      remote_disposition: Type.Union([Type.Literal("none"), Type.Literal("proven_terminal")]),
      lease_disposition: Type.Literal("released"),
      retryable: Type.Literal(false),
      reason_code: Type.Null(),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      outcome: Type.Literal("failed"),
      remote_disposition: Type.Union([
        Type.Literal("none"),
        Type.Literal("proven_not_accepted"),
        Type.Literal("proven_terminal"),
      ]),
      lease_disposition: Type.Literal("released"),
      retryable: Type.Boolean(),
      reason_code: OpaqueIdSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      outcome: Type.Union([Type.Literal("cancelled"), Type.Literal("timed_out")]),
      remote_disposition: Type.Union([
        Type.Literal("none"),
        Type.Literal("proven_not_accepted"),
        Type.Literal("proven_terminal"),
      ]),
      lease_disposition: Type.Literal("released"),
      retryable: Type.Literal(false),
      reason_code: OpaqueIdSchema,
    },
    { additionalProperties: false }
  ),
]);

const QuarantinedHostOperationDispositionV1Schema = Type.Union([
  Type.Object(
    {
      outcome: Type.Union([Type.Literal("cancelled"), Type.Literal("timed_out")]),
      remote_disposition: Type.Union([
        Type.Literal("may_continue"),
        Type.Literal("unknown_acceptance"),
      ]),
      lease_disposition: Type.Literal("quarantined"),
      retryable: Type.Literal(false),
      reason_code: OpaqueIdSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      outcome: Type.Literal("remote_unknown"),
      remote_disposition: Type.Union([
        Type.Literal("unknown_acceptance"),
        Type.Literal("may_continue"),
      ]),
      lease_disposition: Type.Literal("quarantined"),
      retryable: Type.Literal(false),
      reason_code: OpaqueIdSchema,
    },
    { additionalProperties: false }
  ),
]);

export const HostOperationDispositionV1Schema = Type.Union([
  ReleasedHostOperationDispositionV1Schema,
  QuarantinedHostOperationDispositionV1Schema,
]);
export type HostOperationDispositionV1 = Readonly<Static<typeof HostOperationDispositionV1Schema>>;

export const HostOperationResultV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    operation_record_id: OpaqueIdSchema,
    identity: RunIdentitySchema,
    state_id: OpaqueIdSchema,
    attempt: Type.Integer({ minimum: 1 }),
    operation_id: OpaqueIdSchema,
    operation_kind: OpaqueIdSchema,
    registration_sha256: Sha256Schema,
    request_sha256: Sha256Schema,
    lease: Type.Union([HostOperationLeaseIdentityV1Schema, Type.Null()]),
    disposition: HostOperationDispositionV1Schema,
    operation_result_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    output_artifacts: Type.Array(ArtifactRefSchema, { maxItems: 1_024 }),
  },
  { additionalProperties: false }
);
export type HostOperationResultV1 = Readonly<Static<typeof HostOperationResultV1Schema>>;

export const HostOperationReceiptV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    receipt_id: OpaqueIdSchema,
    operation_record_id: OpaqueIdSchema,
    identity: RunIdentitySchema,
    state_id: OpaqueIdSchema,
    attempt: Type.Integer({ minimum: 1 }),
    operation_id: OpaqueIdSchema,
    operation_kind: OpaqueIdSchema,
    registration_sha256: Sha256Schema,
    request_sha256: Sha256Schema,
    started_at: Rfc3339UtcSchema,
    ended_at: Rfc3339UtcSchema,
    progress_event_count: Type.Integer({ minimum: 0 }),
    poll_count: Type.Integer({ minimum: 0 }),
    request_bytes: Type.Integer({ minimum: 0 }),
    output_artifact_count: Type.Integer({ minimum: 0 }),
    output_bytes: Type.Integer({ minimum: 0 }),
    result_sha256: Type.Union([Sha256Schema, Type.Null()]),
    remote_correlation_sha256: Type.Union([Sha256Schema, Type.Null()]),
    lease_disposition_receipt_id: OpaqueIdSchema,
    disposition: HostOperationDispositionV1Schema,
  },
  { additionalProperties: false }
);
export type HostOperationReceiptV1 = Readonly<Static<typeof HostOperationReceiptV1Schema>>;

export const HostOperationProgressV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    sequence: Type.Integer({ minimum: 1 }),
    observed_at: Rfc3339UtcSchema,
    progress_class: Type.Union([
      Type.Literal("queued"),
      Type.Literal("lease_acquired"),
      Type.Literal("submission_started"),
      Type.Literal("remote_accepted"),
      Type.Literal("poll"),
      Type.Literal("fetched"),
      Type.Literal("persisted"),
      Type.Literal("adapter_progress"),
    ]),
    completed_units: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    total_units: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    detail_code: Type.Optional(OpaqueIdSchema),
    metadata: Type.Optional(
      Type.Record(
        OpaqueIdSchema,
        Type.Union([
          Type.Null(),
          Type.Boolean(),
          Type.Integer({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
          Type.String({ maxLength: 256 }),
        ]),
        { maxProperties: MAX_HOST_OPERATION_PROGRESS_METADATA_ENTRIES }
      )
    ),
  },
  { additionalProperties: false }
);
export type HostOperationProgressV1 = Readonly<Static<typeof HostOperationProgressV1Schema>>;
export type HostOperationProgressSink = (progress: HostOperationProgressV1) => void;

export const HostOperationFetchedV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    content_sha256: Sha256Schema,
    byte_length: Type.Integer({ minimum: 0, maximum: 4_294_967_296 }),
    item_count: Type.Integer({ minimum: 0, maximum: 1_024 }),
    poll_count: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  },
  { additionalProperties: false }
);
export type HostOperationFetchedV1 = Readonly<Static<typeof HostOperationFetchedV1Schema>>;

export const HostOperationArtifactPlanV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    operation_id: OpaqueIdSchema,
    version: Type.Integer({ minimum: 1 }),
    artifact_kind: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
    media_type: Type.String({ minLength: 1, maxLength: 128 }),
    schema_id: SchemaIdSchema,
    schema_version_required: Type.Integer({ minimum: 1 }),
    byte_length: Type.Integer({ minimum: 0, maximum: 4_294_967_296 }),
    content_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type HostOperationArtifactPlanV1 = Readonly<
  Static<typeof HostOperationArtifactPlanV1Schema>
>;

export const HostOperationPersistencePlanV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    operation_result: HostOperationArtifactPlanV1Schema,
    outputs: Type.Array(HostOperationArtifactPlanV1Schema, { maxItems: 1_024 }),
    disposition: HostOperationDispositionV1Schema,
  },
  { additionalProperties: false }
);
export type HostOperationPersistencePlanV1 = Readonly<
  Static<typeof HostOperationPersistencePlanV1Schema>
>;

export const HostOperationLifecycleV1Schema = Type.Union([
  Type.Literal("prepared"),
  Type.Literal("lease_acquired"),
  Type.Literal("submitting"),
  Type.Literal("submitted"),
  Type.Literal("fetched"),
  Type.Literal("persisting"),
  Type.Literal("persisted"),
  Type.Literal("verified"),
  Type.Literal("terminal"),
  Type.Literal("settled"),
  Type.Literal("consumed"),
]);
export type HostOperationLifecycleV1 = Static<typeof HostOperationLifecycleV1Schema>;

export const HostOperationCallRecordV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    operation_record_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    identity: RunIdentitySchema,
    state_id: OpaqueIdSchema,
    attempt: Type.Integer({ minimum: 1 }),
    operation_id: OpaqueIdSchema,
    operation_kind: OpaqueIdSchema,
    directive: InvokeHostOperationDirectiveV1Schema,
    directive_sha256: Sha256Schema,
    registration_sha256: Sha256Schema,
    request_ref: ArtifactRefSchema,
    request_sha256: Sha256Schema,
    input_artifacts: InputArtifactsSchema,
    expected_result: HostOperationArtifactContractV1Schema,
    policy_binding: HostOperationPolicyBindingV1Schema,
    lifecycle: HostOperationLifecycleV1Schema,
    lease: Type.Union([HostOperationLeaseIdentityV1Schema, Type.Null()]),
    lease_expires_at_ms: Type.Union([
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      Type.Null(),
    ]),
    queue_inactivity_expires_at_ms: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    operation_inactivity_expires_at_ms: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    remote_correlation_id: Type.Union([
      Type.String({ minLength: 1, maxLength: 8_192 }),
      Type.Null(),
    ]),
    remote_correlation_sha256: Type.Union([Sha256Schema, Type.Null()]),
    fetched: Type.Union([HostOperationFetchedV1Schema, Type.Null()]),
    persistence_plan: Type.Union([HostOperationPersistencePlanV1Schema, Type.Null()]),
    operation_result_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    output_artifacts: Type.Array(ArtifactRefSchema, { maxItems: 1_024 }),
    disposition: Type.Union([HostOperationDispositionV1Schema, Type.Null()]),
    lease_disposition_receipt_id: Type.Union([OpaqueIdSchema, Type.Null()]),
    platform_result_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    host_receipt_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    /** Post-receipt plan is committed before wrapper publication. It is not a receipt input. */
    result_wrapper: Type.Optional(
      Type.Object(
        {
          plan: HostOperationArtifactPlanV1Schema,
          ref: Type.Union([ArtifactRefSchema, Type.Null()]),
        },
        { additionalProperties: false }
      )
    ),
    progress_event_count: Type.Integer({ minimum: 0 }),
    started_at: Rfc3339UtcSchema,
    created_at: Rfc3339UtcSchema,
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type HostOperationCallRecordV1 = Readonly<Static<typeof HostOperationCallRecordV1Schema>>;

export function hostOperationRecordId(input: {
  readonly project_id: string;
  readonly run_id: string;
  readonly state_id: string;
  readonly attempt: number;
  readonly operation_id: string;
  readonly registration_sha256: string;
  readonly request_sha256: string;
}): string {
  return `hop_${sha256(canonicalJson(input))}`;
}

export function hostOperationDirectiveSha256(directive: InvokeHostOperationDirectiveV1): string {
  return sha256(canonicalJson(directive));
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function validateHostOperationCallRecord(value: unknown): HostOperationCallRecordV1 {
  const record = validateSkillSchema(
    HostOperationCallRecordV1Schema,
    value,
    "HostOperationCallRecordV1"
  );
  const expectedRecordId = hostOperationRecordId({
    project_id: record.project_id,
    run_id: record.identity.run_id,
    state_id: record.state_id,
    attempt: record.attempt,
    operation_id: record.operation_id,
    registration_sha256: record.registration_sha256,
    request_sha256: record.request_sha256,
  });
  if (record.operation_record_id !== expectedRecordId) {
    throw new Error("HostOperationCallRecordV1 record ID diverges from immutable operands");
  }
  if (
    record.directive.identity.run_id !== record.identity.run_id ||
    record.directive.state_id !== record.state_id ||
    record.directive.attempt !== record.attempt ||
    record.directive.operation_id !== record.operation_id ||
    record.directive.operation_kind !== record.operation_kind ||
    record.directive.registration_sha256 !== record.registration_sha256 ||
    record.directive.request_sha256 !== record.request_sha256 ||
    !sameCanonical(record.directive.request_ref, record.request_ref) ||
    !sameCanonical(record.directive.input_artifacts, record.input_artifacts) ||
    !sameCanonical(record.directive.expected_result, record.expected_result) ||
    !sameCanonical(record.directive.policy_binding, record.policy_binding)
  ) {
    throw new Error("HostOperationCallRecordV1 directive diverges from persisted operands");
  }
  if (record.directive_sha256 !== hostOperationDirectiveSha256(record.directive)) {
    throw new Error("HostOperationCallRecordV1 directive digest diverges");
  }
  if (
    record.request_sha256 !== record.request_ref.content_digest ||
    record.request_ref.store_ref !== `artifact://sha256/${record.request_sha256}`
  ) {
    throw new Error("HostOperationCallRecordV1 request ref does not bind its digest");
  }
  if (record.operation_inactivity_expires_at_ms < record.queue_inactivity_expires_at_ms) {
    throw new Error(
      "HostOperationCallRecordV1 queue inactivity expiry exceeds operation inactivity expiry"
    );
  }
  if (record.updated_at < record.created_at || record.created_at < record.started_at) {
    throw new Error("HostOperationCallRecordV1 timestamps regress");
  }
  if ((record.remote_correlation_id === null) !== (record.remote_correlation_sha256 === null)) {
    throw new Error("HostOperationCallRecordV1 remote correlation fields disagree");
  }
  if (
    record.remote_correlation_id !== null &&
    sha256(record.remote_correlation_id) !== record.remote_correlation_sha256
  ) {
    throw new Error("HostOperationCallRecordV1 remote correlation digest diverges");
  }
  const requiresLease = !["prepared"].includes(record.lifecycle);
  if (
    requiresLease &&
    record.lease === null &&
    record.lifecycle !== "terminal" &&
    record.lifecycle !== "settled" &&
    record.lifecycle !== "consumed"
  ) {
    throw new Error("HostOperationCallRecordV1 active lifecycle lacks its lease identity");
  }
  if ((record.lease === null) !== (record.lease_expires_at_ms === null)) {
    throw new Error("HostOperationCallRecordV1 lease identity and expiry disagree");
  }
  const terminal =
    record.lifecycle === "terminal" ||
    record.lifecycle === "settled" ||
    record.lifecycle === "consumed";
  if (terminal !== (record.disposition !== null)) {
    throw new Error("HostOperationCallRecordV1 terminal lifecycle and disposition disagree");
  }
  const settled = record.lifecycle === "settled" || record.lifecycle === "consumed";
  if (
    settled !==
    (record.lease_disposition_receipt_id !== null &&
      record.platform_result_ref !== null &&
      record.host_receipt_ref !== null)
  ) {
    throw new Error("HostOperationCallRecordV1 settlement evidence is incomplete");
  }
  if (record.lifecycle === "persisting" && record.persistence_plan === null) {
    throw new Error("HostOperationCallRecordV1 persisting lifecycle lacks its plan");
  }
  if (
    (record.lifecycle === "persisted" ||
      record.lifecycle === "verified" ||
      (terminal && record.disposition?.outcome === "completed")) &&
    record.persistence_plan !== null &&
    record.operation_result_ref === null
  ) {
    throw new Error("HostOperationCallRecordV1 persisted plan lacks its result ref");
  }
  assertUnique(
    record.input_artifacts.artifacts.map((binding) => binding.slot),
    "HostOperationCallRecordV1 input slots"
  );
  assertUnique(
    record.output_artifacts.map((artifact) => artifact.artifact_id),
    "HostOperationCallRecordV1 output artifacts"
  );
  if (
    record.result_wrapper !== undefined &&
    (!settled ||
      record.host_receipt_ref === null ||
      record.operation_result_ref === null ||
      (record.result_wrapper.ref !== null &&
        (record.result_wrapper.ref.content_digest !== record.result_wrapper.plan.content_sha256 ||
          record.result_wrapper.ref.byte_length !== record.result_wrapper.plan.byte_length)))
  ) {
    throw new Error("host-operation wrapper lacks prior settled receipt/raw evidence");
  }
  const recordBytes = Buffer.byteLength(canonicalJson(record), "utf8");
  if (recordBytes === 0 || recordBytes > MAX_HOST_OPERATION_RECORD_BYTES) {
    throw new Error("HostOperationCallRecordV1 exceeds its canonical byte limit");
  }
  return record;
}

export function validateHostOperationResult(value: unknown): HostOperationResultV1 {
  return validateSkillSchema(HostOperationResultV1Schema, value, "HostOperationResultV1");
}

export function validateHostOperationReceipt(value: unknown): HostOperationReceiptV1 {
  const receipt = validateSkillSchema(
    HostOperationReceiptV1Schema,
    value,
    "HostOperationReceiptV1"
  );
  if (receipt.ended_at < receipt.started_at) {
    throw new Error("HostOperationReceiptV1 ended before it started");
  }
  if (Buffer.byteLength(canonicalJson(receipt), "utf8") > MAX_HOST_OPERATION_RECEIPT_BYTES) {
    throw new Error("HostOperationReceiptV1 exceeds its canonical byte limit");
  }
  return receipt;
}

export function validateHostOperationProgress(value: unknown): HostOperationProgressV1 {
  const progress = validateSkillSchema(
    HostOperationProgressV1Schema,
    value,
    "HostOperationProgressV1"
  );
  if (
    progress.completed_units !== undefined &&
    progress.total_units !== undefined &&
    progress.completed_units > progress.total_units
  ) {
    throw new Error("HostOperationProgressV1 completed units exceed total units");
  }
  return progress;
}

export interface HostOperationRequestInspectionV1 {
  readonly directive: InvokeHostOperationDirectiveV1;
  readonly declaration: HostOperationDeclarationV1;
  readonly request_bytes: Uint8Array;
  readonly input_artifacts: InvokeHostOperationDirectiveV1["input_artifacts"];
}

export interface HostOperationRequestBindingV1 {
  readonly schema_version: 1;
  readonly operation_kind: string;
  readonly adapter_id: string;
  readonly backend_binding_id: string;
  readonly backend_key_sha256: string;
}

export interface HostOperationArtifactWriteV1 {
  readonly contract: HostOperationArtifactContractV1;
  readonly media_type: string;
  readonly content: Uint8Array | string;
}

export interface HostOperationPersistenceInputV1 {
  readonly disposition: HostOperationDispositionV1;
  readonly operation_result: HostOperationArtifactWriteV1;
  readonly outputs?: readonly HostOperationArtifactWriteV1[];
}

export interface HostOperationPersistedOutputV1 {
  readonly operation_result_ref: ArtifactRef;
  readonly output_artifacts: readonly ArtifactRef[];
}

export type HostOperationRemoteCancellationResultV1 =
  | {
      readonly remote_disposition: "proven_terminal";
      readonly reason_code: string;
    }
  | {
      readonly remote_disposition: "may_continue";
      readonly reason_code: string;
    };

export interface HostOperationExactInputV1 {
  readonly ref: ArtifactRef;
  readonly bytes: Uint8Array;
}

export type { HostOperationCachedResultV1, HostOperationResultCacheV1 };

export interface HostOperationExecutionContextV1 {
  readonly directive: InvokeHostOperationDirectiveV1;
  readonly declaration: HostOperationDeclarationV1;
  readonly request_bytes: Uint8Array;
  readonly journal: HostOperationCallRecordV1;
  readonly signal: AbortSignal;
  /** Renew the operation lease only from trusted adapter-observed productive activity. */
  reportActivity(activityClass: string, observedUnits?: number): void;
  /** Present only with explicit host capacity/productive-source opt-in. The callback carries
   * no evidence, counters or authority; the owner reads exact durable host-selected evidence. */
  observeProductiveProgress?: () => void;
  /** Exact, registration-bounded directive inputs only; this is not an artifact discovery surface. */
  readInput(slot: string): HostOperationExactInputV1;
  emitProgress(
    progress: Omit<HostOperationProgressV1, "schema_version" | "sequence" | "observed_at">
  ): void;
  beginSubmission(): void;
  recordRemoteAccepted(remoteCorrelationId: string): void;
  /** Host-owned exact-byte cache; adapters must cache before journaling fetched metadata. */
  cacheResult(bytes: Uint8Array): Promise<HostOperationCachedResultV1>;
  /** Exact cached bytes for restart adoption, keyed only by this directive's request digest. */
  readCachedResult(): Promise<HostOperationCachedResultV1 | null>;
  recordFetched(fetched: HostOperationFetchedV1): void;
  persist(input: HostOperationPersistenceInputV1): HostOperationPersistedOutputV1;
  registerRemoteCancellation(
    callback: (signal: AbortSignal) => Promise<HostOperationRemoteCancellationResultV1>
  ): void;
}

export interface HostOperationAdapterTerminalV1 {
  readonly disposition: HostOperationDispositionV1;
  readonly operation_result_ref: ArtifactRef | null;
  readonly output_artifacts: readonly ArtifactRef[];
}

export interface HostOperationAdapterV1 {
  readonly adapter_id: string;
  inspectRequest(input: HostOperationRequestInspectionV1): HostOperationRequestBindingV1;
  /** Close/acquire real external ingress after a held fence and BEFORE native baseline. */
  prepare?(context: HostOperationExecutionContextV1): Promise<void>;
  close?(): void;
  run(context: HostOperationExecutionContextV1): Promise<HostOperationAdapterTerminalV1>;
}

export const HostOperationDispositionReceiptV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    receipt_id: OpaqueIdSchema,
    operation_record_id: OpaqueIdSchema,
    backend_key_sha256: Sha256Schema,
    lease: Type.Union([HostOperationLeaseIdentityV1Schema, Type.Null()]),
    disposition: HostOperationDispositionV1Schema,
    remote_correlation_sha256: Type.Union([Sha256Schema, Type.Null()]),
    created_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type HostOperationDispositionReceiptV1 = Readonly<
  Static<typeof HostOperationDispositionReceiptV1Schema>
>;

export function validateHostOperationDispositionReceipt(
  value: unknown
): HostOperationDispositionReceiptV1 {
  return validateSkillSchema(
    HostOperationDispositionReceiptV1Schema,
    value,
    "HostOperationDispositionReceiptV1"
  );
}

export interface HostOperationQuarantineResetV1 {
  readonly schema_version: 1;
  readonly reset_receipt_id: string;
  readonly backend_key_sha256: string;
  readonly quarantine_id: string;
  readonly disposition: "queue_inspected_empty" | "queue_drained" | "specific_remote_terminal";
  readonly evidence_sha256: string;
  readonly queue_snapshot_sha256: string;
  readonly reset_at: string;
}

/** Metadata payloads are deliberately constrained to JSON scalars by HostOperationProgressV1. */
export type HostOperationProgressMetadataV1 = Readonly<Record<string, JsonValue>>;
