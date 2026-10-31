import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  ChildWorkflowBudgetAllocationV1Schema,
  ChildWorkflowOutputContractV1Schema,
  ChildWorkflowPolicyBindingV1Schema,
  ChildWorkflowProgressLeaseBindingV1Schema,
  InputArtifactsSchema,
  InvokeChildWorkflowDirectiveSchema,
  LeaseBoundInvokeChildWorkflowDirectiveV1Schema,
  RunIdentitySchema,
  type ArtifactRef,
  type ChildWorkflowBudgetAllocationV1,
  type ChildWorkflowOutputContractV1,
  type ChildWorkflowPolicyBindingV1,
  type ChildWorkflowProgressLeaseBindingV1,
  type InvokeChildWorkflowDirective,
  type LeaseBoundInvokeChildWorkflowDirectiveV1,
  type JsonValue,
  type RunIdentity,
} from "../contracts.js";
import {
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  SchemaIdSchema,
  Sha256Schema,
  TextSchema,
  assertOpaqueId,
  assertRfc3339Utc,
  assertText,
  assertUnique,
  validateSkillSchema,
} from "../skill-contracts/common.js";

const MAX_CHILD_REQUEST_BYTES = 65_536;
const MAX_CHILD_REQUEST_DEPTH = 16;
const MAX_CHILD_REQUEST_MEMBERS = 256;
const MAX_CONTEXT_ENTRIES = 64;
const MAX_CONTEXT_REFS = 64;
const MAX_CONTEXT_LIMITATIONS = 32;
const MAX_CONTEXT_BYTES = 1_048_576;
const MAX_POLICY_TARGETS = 16;
const MAX_POLICY_CALLS = 64;
const MAX_RESULT_ARTIFACTS = 128;
const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type ChildWorkflowRequestSchemaValue = Static<typeof ChildWorkflowRequestV1Schema>;
type BudgetVectorV1 = Pick<
  ChildWorkflowBudgetAllocationV1,
  "model_turns" | "tool_calls" | "external_calls" | "wall_clock_ms" | "max_steps" | "output_bytes"
>;
type DataPropertyDescriptor = Omit<PropertyDescriptor, "value"> & {
  readonly value: unknown;
};

function isDataPropertyDescriptor(
  descriptor: PropertyDescriptor | undefined
): descriptor is DataPropertyDescriptor {
  return (
    descriptor !== undefined &&
    descriptor.get === undefined &&
    descriptor.set === undefined &&
    Object.hasOwn(descriptor, "value")
  );
}

/**
 * The native provider request is intentionally parsed by the bounded runtime validator below.
 * TypeBox's general cyclic JSON schema would otherwise have no request-specific depth/member
 * budget at this cross-workflow boundary. The generic envelope never substitutes a common
 * request meaning for the provider's registered native request contract.
 */
export const ChildWorkflowRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.child-workflow-request.v1"),
    schema_version: Type.Literal(1),
    child_name: OpaqueIdSchema,
    provider_request_schema_id: SchemaIdSchema,
    provider_request_schema_version: Type.Integer({ minimum: 1 }),
    provider_request: Type.Unknown(),
    /** Explicit Define/Plan invocation policy; absence is legacy V1 semantic-only. */
    invocation_policy: Type.Optional(
      Type.Object(
        {
          schema_version: Type.Literal(2),
          specification_assurance: Type.Union([
            Type.Literal("reviewed_definition"),
            Type.Literal("semantic_only"),
          ]),
        },
        { additionalProperties: false }
      )
    ),
    policy_binding: ChildWorkflowPolicyBindingV1Schema,
  },
  { additionalProperties: false }
);
export type ChildWorkflowRequestV1 = Readonly<
  Omit<ChildWorkflowRequestSchemaValue, "provider_request"> & {
    readonly provider_request: JsonValue;
  }
>;

function boundedJson(value: unknown, label: string): JsonValue {
  const active = new WeakSet<object>();
  let memberCount = 0;

  const consumeMember = (): void => {
    memberCount += 1;
    if (memberCount > MAX_CHILD_REQUEST_MEMBERS) {
      throw new Error(`${label} exceeds ${MAX_CHILD_REQUEST_MEMBERS} aggregate members`);
    }
  };

  const visit = (candidate: unknown, depth: number): JsonValue => {
    if (depth > MAX_CHILD_REQUEST_DEPTH) {
      throw new Error(`${label} exceeds ${MAX_CHILD_REQUEST_DEPTH} nesting levels`);
    }
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "string") {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error(`${label} contains a non-finite number`);
      return candidate;
    }
    if (Array.isArray(candidate)) {
      if (active.has(candidate)) throw new Error(`${label} contains a cycle`);
      active.add(candidate);
      const values = candidate.map((item) => {
        consumeMember();
        return visit(item, depth + 1);
      });
      active.delete(candidate);
      return values;
    }
    if (candidate === null || typeof candidate !== "object") {
      throw new Error(`${label} is not JSON-compatible`);
    }
    const prototype = Reflect.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} contains a non-plain object`);
    }
    if (active.has(candidate)) throw new Error(`${label} contains a cycle`);
    active.add(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (!isDataPropertyDescriptor(descriptor)) {
        throw new Error(`${label} contains an accessor property`);
      }
      if (FORBIDDEN_JSON_KEYS.has(key)) throw new Error(`${label} contains an unsafe key`);
      consumeMember();
      output[key] = visit(descriptor.value, depth + 1);
    }
    active.delete(candidate);
    return output;
  };

  const parsed = visit(value, 0);
  const bytes = Buffer.byteLength(canonicalJson(parsed), "utf8");
  if (bytes > MAX_CHILD_REQUEST_BYTES) {
    throw new Error(`${label} exceeds ${MAX_CHILD_REQUEST_BYTES} canonical UTF-8 bytes`);
  }
  return parsed;
}

function canonicalByteLength(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

function assertCanonicalBytesAtMost(value: unknown, label: string, maximum: number): void {
  const bytes = canonicalByteLength(value);
  if (bytes === 0 || bytes > maximum) {
    throw new Error(`${label} must contain 1..${maximum} canonical UTF-8 bytes`);
  }
}

function assertArtifactRefIdentity(ref: ArtifactRef, label: string): void {
  if (ref.store_ref !== `artifact://sha256/${ref.content_digest}`) {
    throw new Error(`${label} store ref does not bind its content digest`);
  }
}

function assertArtifactRefsIdentity(refs: readonly ArtifactRef[], label: string): void {
  refs.forEach((ref, index) => assertArtifactRefIdentity(ref, `${label}[${index}]`));
  assertUnique(
    refs.map((ref) => ref.artifact_id),
    `${label} artifact IDs`
  );
}

function assertOutputArtifactMatchesContract(
  artifact: ArtifactRef,
  output: ChildWorkflowOutputContractV1,
  label: string
): void {
  assertArtifactRefIdentity(artifact, label);
  if (
    artifact.kind !== output.artifact_kind ||
    artifact.content_schema?.schema_id !== output.schema_id ||
    artifact.content_schema.schema_version !== output.schema_version_required
  ) {
    throw new Error(`${label} does not match the expected exact output contract`);
  }
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function validateChildWorkflowRequest(value: unknown): ChildWorkflowRequestV1 {
  const request = validateSkillSchema(
    ChildWorkflowRequestV1Schema,
    value,
    "ChildWorkflowRequestV1"
  );
  assertOpaqueId(request.child_name, "ChildWorkflowRequestV1.child_name");
  for (const [label, item] of [
    ["project_id", request.policy_binding.project_id],
    ["principal_id", request.policy_binding.principal_id],
    ["scope_id", request.policy_binding.scope_id],
    ["source_policy_id", request.policy_binding.source_policy_id],
    ["destination_policy_id", request.policy_binding.destination_policy_id],
  ] as const) {
    assertOpaqueId(item, `ChildWorkflowRequestV1.policy_binding.${label}`);
  }
  const normalized = {
    ...request,
    provider_request: boundedJson(
      request.provider_request,
      "ChildWorkflowRequestV1.provider_request"
    ),
  };
  assertCanonicalBytesAtMost(normalized, "ChildWorkflowRequestV1", MAX_CHILD_REQUEST_BYTES);
  return normalized;
}

export function validateCanonicalChildWorkflowRequestBytes(
  bytes: Uint8Array,
  ref: ArtifactRef
): ChildWorkflowRequestV1 {
  const body = Buffer.from(bytes);
  if (
    body.byteLength === 0 ||
    body.byteLength > MAX_CHILD_REQUEST_BYTES ||
    ref.kind !== "child-request" ||
    ref.content_schema?.schema_id !== "penny.child-workflow-request.v1" ||
    ref.content_schema.schema_version !== 1 ||
    ref.byte_length !== body.byteLength ||
    ref.content_digest !== sha256(body) ||
    ref.store_ref !== `artifact://sha256/${ref.content_digest}`
  ) {
    throw new Error("ChildWorkflowRequestV1 artifact ref is stale or has the wrong identity");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("ChildWorkflowRequestV1 artifact is not JSON");
  }
  const request = validateChildWorkflowRequest(parsed);
  if (canonicalJson(request) !== body.toString("utf8")) {
    throw new Error("ChildWorkflowRequestV1 artifact bytes are not canonical JSON");
  }
  return request;
}

/** Every range is half-open: `start` is included and `end` is excluded. */
const EvidenceSelectorV1Schema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("byte_range"),
      start: Type.Integer({ minimum: 0, maximum: MAX_CONTEXT_BYTES - 1 }),
      end: Type.Integer({ minimum: 1, maximum: MAX_CONTEXT_BYTES }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("line_range"),
      start: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
      end: Type.Integer({ minimum: 2, maximum: 1_000_001 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("json_pointer"),
      pointer: Type.String({ minLength: 1, maxLength: 2_048, pattern: "^/" }),
    },
    { additionalProperties: false }
  ),
]);

const EvidenceContextEntryV1Schema = Type.Object(
  {
    entry_id: OpaqueIdSchema,
    source_type: Type.Union([
      Type.Literal("artifact"),
      Type.Literal("document"),
      Type.Literal("tool_output"),
      Type.Literal("caller_supplied"),
    ]),
    source_ref: ArtifactRefSchema,
    selector: EvidenceSelectorV1Schema,
    classification: Type.Union([
      Type.Literal("observation"),
      Type.Literal("supplied_claim"),
      Type.Literal("inference"),
      Type.Literal("assumption"),
      Type.Literal("unknown"),
    ]),
    statement: TextSchema({ minBytes: 1, maxBytes: 16_384, multiline: true }),
    uncertainty: Type.Union([
      Type.Object({ status: Type.Literal("none") }, { additionalProperties: false }),
      Type.Object(
        {
          status: Type.Literal("explicit"),
          statement: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
        },
        { additionalProperties: false }
      ),
    ]),
  },
  { additionalProperties: false }
);

export const EvidenceContextV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.evidence-context.v1"),
    schema_version: Type.Literal(1),
    purpose: TextSchema({ minBytes: 1, maxBytes: 16_384, multiline: true }),
    question: TextSchema({ minBytes: 1, maxBytes: 16_384, multiline: true }),
    origin: Type.Object(
      {
        project_id: OpaqueIdSchema,
        principal_id: OpaqueIdSchema,
        scope_id: OpaqueIdSchema,
        snapshot_id: OpaqueIdSchema,
      },
      { additionalProperties: false }
    ),
    policy: Type.Object(
      {
        source_policy_id: OpaqueIdSchema,
        destination_policy_id: OpaqueIdSchema,
      },
      { additionalProperties: false }
    ),
    entries: Type.Array(EvidenceContextEntryV1Schema, {
      minItems: 1,
      maxItems: MAX_CONTEXT_ENTRIES,
    }),
    transitive_refs: Type.Array(ArtifactRefSchema, {
      minItems: 1,
      maxItems: MAX_CONTEXT_REFS,
    }),
    limitations: Type.Array(TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }), {
      maxItems: MAX_CONTEXT_LIMITATIONS,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
export type EvidenceContextV1 = Readonly<Static<typeof EvidenceContextV1Schema>>;

export function validateEvidenceContext(value: unknown): EvidenceContextV1 {
  const context = validateSkillSchema(EvidenceContextV1Schema, value, "EvidenceContextV1");
  assertCanonicalBytesAtMost(context, "EvidenceContextV1", MAX_CONTEXT_BYTES);
  for (const [label, text, maxBytes] of [
    ["purpose", context.purpose, 16_384],
    ["question", context.question, 16_384],
  ] as const) {
    assertText(text, `EvidenceContextV1.${label}`, {
      minBytes: 1,
      maxBytes,
      multiline: true,
      trimmedNonEmpty: true,
    });
  }
  for (const [label, id] of Object.entries({ ...context.origin, ...context.policy })) {
    assertOpaqueId(id, `EvidenceContextV1.${label}`);
  }
  assertUnique(
    context.entries.map((entry) => entry.entry_id),
    "EvidenceContextV1 entry IDs"
  );
  assertUnique(
    context.transitive_refs.map((ref) => ref.artifact_id),
    "EvidenceContextV1 transitive refs"
  );
  const refs = new Map(context.transitive_refs.map((ref) => [ref.artifact_id, ref]));
  for (const [index, entry] of context.entries.entries()) {
    assertOpaqueId(entry.entry_id, `EvidenceContextV1.entries[${index}].entry_id`);
    assertArtifactRefIdentity(entry.source_ref, `EvidenceContextV1.entries[${index}].source_ref`);
    assertText(entry.statement, `EvidenceContextV1.entries[${index}].statement`, {
      minBytes: 1,
      maxBytes: 16_384,
      multiline: true,
      trimmedNonEmpty: true,
    });
    if (entry.uncertainty.status === "explicit") {
      assertText(entry.uncertainty.statement, `EvidenceContextV1.entries[${index}].uncertainty`, {
        minBytes: 1,
        maxBytes: 4_096,
        multiline: true,
        trimmedNonEmpty: true,
      });
    }
    if (
      (entry.selector.kind === "byte_range" || entry.selector.kind === "line_range") &&
      entry.selector.end <= entry.selector.start
    ) {
      throw new Error(`EvidenceContextV1 entry '${entry.entry_id}' must select a non-empty range`);
    }
    const exact = refs.get(entry.source_ref.artifact_id);
    if (exact === undefined || !sameCanonical(exact, entry.source_ref)) {
      throw new Error(`EvidenceContextV1 entry '${entry.entry_id}' lacks its exact transitive ref`);
    }
  }
  for (const [index, limitation] of context.limitations.entries()) {
    assertText(limitation, `EvidenceContextV1.limitations[${index}]`, {
      minBytes: 1,
      maxBytes: 4_096,
      multiline: true,
      trimmedNonEmpty: true,
    });
  }
  return context;
}

export function validateCanonicalEvidenceContextBytes(
  bytes: Uint8Array,
  ref: ArtifactRef
): EvidenceContextV1 {
  const body = Buffer.from(bytes);
  if (
    body.byteLength === 0 ||
    body.byteLength > MAX_CONTEXT_BYTES ||
    ref.kind !== "evidence-context" ||
    ref.content_schema?.schema_id !== "penny.evidence-context.v1" ||
    ref.content_schema.schema_version !== 1 ||
    ref.byte_length !== body.byteLength ||
    ref.content_digest !== sha256(body) ||
    ref.store_ref !== `artifact://sha256/${ref.content_digest}`
  ) {
    throw new Error("EvidenceContextV1 artifact ref is stale or has the wrong identity");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("EvidenceContextV1 artifact is not JSON");
  }
  const context = validateEvidenceContext(parsed);
  if (canonicalJson(context) !== body.toString("utf8")) {
    throw new Error("EvidenceContextV1 artifact bytes are not canonical JSON");
  }
  return context;
}

/**
 * Fenced owner coordinates and progress state are content-free control data. The future storage
 * owner persists them; CW-01 only validates and reduces the contract without dispatching work.
 */
export const ChildWorkflowExecutionFenceV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    owner_epoch: Type.Integer({ minimum: 1 }),
    execution_attempt_id: OpaqueIdSchema,
    worker_session_id: OpaqueIdSchema,
    fencing_token_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type ChildWorkflowExecutionFenceV1 = Readonly<
  Static<typeof ChildWorkflowExecutionFenceV1Schema>
>;

const WorkerActivityClassV1Schema = Type.Union([
  Type.Literal("assistant_text_delta"),
  Type.Literal("assistant_thinking_delta"),
  Type.Literal("tool_execution_started"),
  Type.Literal("tool_execution_updated"),
  Type.Literal("tool_execution_completed"),
  Type.Literal("provider_turn_ended"),
  Type.Literal("worker_completed"),
  Type.Literal("host_context_resolution_progress"),
]);
export type WorkerActivityClassV1 = Static<typeof WorkerActivityClassV1Schema>;

const WorkflowConvergenceClassV1Schema = Type.Union([
  Type.Literal("state_transition"),
  Type.Literal("artifact_admitted"),
  Type.Literal("evidence_admitted"),
  Type.Literal("repair_strategy_changed"),
  Type.Literal("terminal_transition"),
  Type.Literal("gate_transition"),
]);
export type WorkflowConvergenceClassV1 = Static<typeof WorkflowConvergenceClassV1Schema>;

const ProgressSignalBaseV1 = {
  schema_version: Type.Literal(1),
  source: Type.Literal("trusted_host_observed"),
  fence: ChildWorkflowExecutionFenceV1Schema,
  signal_sequence: Type.Integer({ minimum: 1 }),
  observed_at_ms: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 2_592_000_000 }),
  /** A non-empty event's bounded byte/token/count measure; raw payloads are never retained. */
  observed_units: Type.Integer({ minimum: 1, maximum: 16_777_216 }),
} as const;

export const ChildWorkflowProgressSignalV1Schema = Type.Union([
  Type.Object(
    {
      ...ProgressSignalBaseV1,
      kind: Type.Literal("worker_activity"),
      activity_class: WorkerActivityClassV1Schema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...ProgressSignalBaseV1,
      kind: Type.Literal("workflow_convergence"),
      convergence_class: WorkflowConvergenceClassV1Schema,
      /** Digest of an engine-owned durable coordinate, never a payload/body. */
      convergence_coordinate_sha256: Sha256Schema,
    },
    { additionalProperties: false }
  ),
]);
export type ChildWorkflowProgressSignalV1 = Readonly<
  Static<typeof ChildWorkflowProgressSignalV1Schema>
>;

export const ChildWorkflowProgressLeaseStateV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    binding: ChildWorkflowProgressLeaseBindingV1Schema,
    fence: ChildWorkflowExecutionFenceV1Schema,
    state: Type.Union([
      Type.Literal("active"),
      Type.Literal("suspended"),
      Type.Literal("expired"),
      Type.Literal("closed"),
    ]),
    lease_expires_at_ms: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    last_accepted_signal_sequence: Type.Integer({ minimum: 0 }),
    last_accepted_at_ms: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    last_activity: Type.Union([
      Type.Null(),
      Type.Object(
        {
          kind: Type.Union([WorkerActivityClassV1Schema, WorkflowConvergenceClassV1Schema]),
          observed_at_ms: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
          observed_units: Type.Integer({ minimum: 1, maximum: 16_777_216 }),
        },
        { additionalProperties: false }
      ),
    ]),
    last_convergence: Type.Union([
      Type.Null(),
      Type.Object(
        {
          kind: WorkflowConvergenceClassV1Schema,
          observed_at_ms: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
          coordinate_sha256: Sha256Schema,
        },
        { additionalProperties: false }
      ),
    ]),
    convergence_epoch: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false }
);
export type ChildWorkflowProgressLeaseStateV1 = Readonly<
  Static<typeof ChildWorkflowProgressLeaseStateV1Schema>
>;

export function validateChildWorkflowExecutionFence(value: unknown): ChildWorkflowExecutionFenceV1 {
  return validateSkillSchema(
    ChildWorkflowExecutionFenceV1Schema,
    value,
    "ChildWorkflowExecutionFenceV1"
  );
}

export function validateChildWorkflowProgressLeaseBinding(
  value: unknown
): ChildWorkflowProgressLeaseBindingV1 {
  return validateSkillSchema(
    ChildWorkflowProgressLeaseBindingV1Schema,
    value,
    "ChildWorkflowProgressLeaseBindingV1"
  );
}

export function validateLeaseBoundInvokeChildWorkflowDirective(
  value: unknown
): LeaseBoundInvokeChildWorkflowDirectiveV1 {
  const directive = validateSkillSchema(
    LeaseBoundInvokeChildWorkflowDirectiveV1Schema,
    value,
    "LeaseBoundInvokeChildWorkflowDirectiveV1"
  );
  validateChildWorkflowProgressLeaseBinding(directive.progress_lease);
  return directive;
}

export function validateChildWorkflowProgressSignal(value: unknown): ChildWorkflowProgressSignalV1 {
  const signal = validateSkillSchema(
    ChildWorkflowProgressSignalV1Schema,
    value,
    "ChildWorkflowProgressSignalV1"
  );
  validateChildWorkflowExecutionFence(signal.fence);
  return signal;
}

export function validateChildWorkflowProgressLeaseState(
  value: unknown
): ChildWorkflowProgressLeaseStateV1 {
  const state = validateSkillSchema(
    ChildWorkflowProgressLeaseStateV1Schema,
    value,
    "ChildWorkflowProgressLeaseStateV1"
  );
  validateChildWorkflowProgressLeaseBinding(state.binding);
  validateChildWorkflowExecutionFence(state.fence);
  if (state.last_accepted_at_ms > state.lease_expires_at_ms) {
    throw new Error("ChildWorkflowProgressLeaseStateV1 last accepted time exceeds lease expiry");
  }
  return state;
}

/**
 * Pure contract reducer for CW-05. It permits only a monotonic signal from the currently fenced
 * owner, renews one inactivity interval, and resets convergence accounting only for durable
 * workflow convergence—not for non-empty worker activity or tool churn.
 */
export function applyChildWorkflowProgressSignal(input: {
  readonly state: ChildWorkflowProgressLeaseStateV1;
  readonly signal: ChildWorkflowProgressSignalV1;
}): ChildWorkflowProgressLeaseStateV1 {
  const state = validateChildWorkflowProgressLeaseState(input.state);
  const signal = validateChildWorkflowProgressSignal(input.signal);
  if (state.state !== "active") {
    throw new Error("ChildWorkflowProgressLeaseStateV1 cannot accept a signal while inactive");
  }
  if (!sameCanonical(state.fence, signal.fence)) {
    throw new Error("ChildWorkflowProgressLeaseStateV1 rejects a stale owner fence");
  }
  if (signal.signal_sequence <= state.last_accepted_signal_sequence) {
    throw new Error("ChildWorkflowProgressLeaseStateV1 rejects a replayed signal sequence");
  }
  if (signal.observed_at_ms < state.last_accepted_at_ms) {
    throw new Error("ChildWorkflowProgressLeaseStateV1 rejects a stale signal time");
  }
  const leaseExpiresAtMs = signal.observed_at_ms + state.binding.inactivity_interval_ms;
  if (!Number.isSafeInteger(leaseExpiresAtMs)) {
    throw new Error("ChildWorkflowProgressLeaseStateV1 lease expiry exceeds safe integer range");
  }
  const lastActivity =
    signal.kind === "worker_activity"
      ? {
          kind: signal.activity_class,
          observed_at_ms: signal.observed_at_ms,
          observed_units: signal.observed_units,
        }
      : {
          kind: signal.convergence_class,
          observed_at_ms: signal.observed_at_ms,
          observed_units: signal.observed_units,
        };
  const next = {
    ...state,
    lease_expires_at_ms: leaseExpiresAtMs,
    last_accepted_signal_sequence: signal.signal_sequence,
    last_accepted_at_ms: signal.observed_at_ms,
    last_activity: lastActivity,
    ...(signal.kind === "workflow_convergence"
      ? {
          last_convergence: {
            kind: signal.convergence_class,
            observed_at_ms: signal.observed_at_ms,
            coordinate_sha256: signal.convergence_coordinate_sha256,
          },
          convergence_epoch: state.convergence_epoch + 1,
        }
      : {}),
  };
  return validateChildWorkflowProgressLeaseState(next);
}

export const ChildWorkflowBudgetCeilingV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    model_turns: Type.Integer({ minimum: 0, maximum: 1_024 }),
    tool_calls: Type.Integer({ minimum: 0, maximum: 4_096 }),
    external_calls: Type.Integer({ minimum: 0, maximum: 1_024 }),
    wall_clock_ms: Type.Integer({ minimum: 0, maximum: 86_400_000 }),
    max_steps: Type.Integer({ minimum: 0, maximum: 4_096 }),
    output_bytes: Type.Integer({ minimum: 0, maximum: 16_777_216 }),
  },
  { additionalProperties: false }
);
export type ChildWorkflowBudgetCeilingV1 = Readonly<
  Static<typeof ChildWorkflowBudgetCeilingV1Schema>
>;

export const ChildWorkflowTargetPolicyV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    child_name: OpaqueIdSchema,
    child_request_schema_id: SchemaIdSchema,
    child_request_schema_version: Type.Integer({ minimum: 1 }),
    child_behavior_sha256: Sha256Schema,
    expected_output: ChildWorkflowOutputContractV1Schema,
    scope_id: OpaqueIdSchema,
    source_policy_id: OpaqueIdSchema,
    destination_policy_id: OpaqueIdSchema,
  },
  { additionalProperties: false }
);
export type ChildWorkflowTargetPolicyV1 = Readonly<
  Static<typeof ChildWorkflowTargetPolicyV1Schema>
>;

/**
 * Parent capability is represented even when `targets` is empty. An empty target set and zero
 * `max_calls` are the deny-by-default policy for a parent that has no approved child need.
 */
export const ChildWorkflowPolicyV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    max_nesting_depth: Type.Literal(1),
    max_active_children: Type.Literal(1),
    max_calls: Type.Integer({ minimum: 0, maximum: MAX_POLICY_CALLS }),
    project_concurrency_limit: Type.Integer({ minimum: 1, maximum: MAX_POLICY_CALLS }),
    total_budget: ChildWorkflowBudgetCeilingV1Schema,
    parent_sealing_reserve: ChildWorkflowBudgetCeilingV1Schema,
    targets: Type.Array(ChildWorkflowTargetPolicyV1Schema, {
      maxItems: MAX_POLICY_TARGETS,
    }),
  },
  { additionalProperties: false }
);
export type ChildWorkflowPolicyV1 = Readonly<Static<typeof ChildWorkflowPolicyV1Schema>>;

export const DEFAULT_CHILD_WORKFLOW_POLICY_V1 = Object.freeze({
  schema_version: 1,
  max_nesting_depth: 1,
  max_active_children: 1,
  max_calls: 0,
  project_concurrency_limit: 1,
  total_budget: {
    schema_version: 1,
    model_turns: 0,
    tool_calls: 0,
    external_calls: 0,
    wall_clock_ms: 0,
    max_steps: 0,
    output_bytes: 0,
  },
  parent_sealing_reserve: {
    schema_version: 1,
    model_turns: 0,
    tool_calls: 0,
    external_calls: 0,
    wall_clock_ms: 0,
    max_steps: 0,
    output_bytes: 0,
  },
  targets: [],
} as const satisfies ChildWorkflowPolicyV1);

function budgetAtMost(child: BudgetVectorV1, parent: BudgetVectorV1): boolean {
  return (
    child.model_turns <= parent.model_turns &&
    child.tool_calls <= parent.tool_calls &&
    child.external_calls <= parent.external_calls &&
    child.wall_clock_ms <= parent.wall_clock_ms &&
    child.max_steps <= parent.max_steps &&
    child.output_bytes <= parent.output_bytes
  );
}

export function validateChildWorkflowPolicy(value: unknown): ChildWorkflowPolicyV1 {
  const policy = validateSkillSchema(ChildWorkflowPolicyV1Schema, value, "ChildWorkflowPolicyV1");
  assertUnique(
    policy.targets.map((target) => target.child_name),
    "ChildWorkflowPolicyV1 child targets"
  );
  if (!budgetAtMost(policy.parent_sealing_reserve, policy.total_budget)) {
    throw new Error("ChildWorkflowPolicyV1 sealing reserve exceeds the aggregate budget");
  }
  if (policy.targets.length === 0 && policy.max_calls !== 0) {
    throw new Error("ChildWorkflowPolicyV1 empty parent policy must reserve zero child calls");
  }
  if (policy.targets.length > 0 && policy.max_calls === 0) {
    throw new Error("ChildWorkflowPolicyV1 allowed child targets require a positive call budget");
  }
  for (const target of policy.targets) {
    for (const id of [
      target.child_name,
      target.scope_id,
      target.source_policy_id,
      target.destination_policy_id,
    ]) {
      assertOpaqueId(id, "ChildWorkflowPolicyV1 target identity");
    }
    if (target.child_request_schema_id !== "penny.child-workflow-request.v1") {
      throw new Error("ChildWorkflowPolicyV1 only admits the canonical child request schema");
    }
    if (target.child_request_schema_version !== 1) {
      throw new Error("ChildWorkflowPolicyV1 only admits child request schema version 1");
    }
  }
  return policy;
}

/** A V2 target binds the exact content-free lease profile that later dispatch must freeze. */
export const ChildWorkflowTargetPolicyV2Schema = Type.Object(
  {
    schema_version: Type.Literal(2),
    child_name: OpaqueIdSchema,
    child_request_schema_id: SchemaIdSchema,
    child_request_schema_version: Type.Integer({ minimum: 1 }),
    child_behavior_sha256: Sha256Schema,
    expected_output: ChildWorkflowOutputContractV1Schema,
    scope_id: OpaqueIdSchema,
    source_policy_id: OpaqueIdSchema,
    destination_policy_id: OpaqueIdSchema,
    progress_lease: ChildWorkflowProgressLeaseBindingV1Schema,
  },
  { additionalProperties: false }
);
export type ChildWorkflowTargetPolicyV2 = Readonly<
  Static<typeof ChildWorkflowTargetPolicyV2Schema>
>;

/**
 * Active parent policy: topology/capacity authority plus a renewable progress lease. It contains no
 * guessed model-turn, tool-call, step, output, or aggregate execution budget.
 */
export const ChildWorkflowPolicyV2Schema = Type.Object(
  {
    schema_version: Type.Literal(2),
    max_nesting_depth: Type.Literal(1),
    max_active_children: Type.Literal(1),
    max_calls: Type.Integer({ minimum: 0, maximum: MAX_POLICY_CALLS }),
    project_concurrency_limit: Type.Integer({ minimum: 1, maximum: MAX_POLICY_CALLS }),
    targets: Type.Array(ChildWorkflowTargetPolicyV2Schema, { maxItems: MAX_POLICY_TARGETS }),
  },
  { additionalProperties: false }
);
export type ChildWorkflowPolicyV2 = Readonly<Static<typeof ChildWorkflowPolicyV2Schema>>;

export const DEFAULT_CHILD_WORKFLOW_POLICY_V2 = Object.freeze({
  schema_version: 2,
  max_nesting_depth: 1,
  max_active_children: 1,
  max_calls: 0,
  project_concurrency_limit: 1,
  targets: [],
} as const satisfies ChildWorkflowPolicyV2);

export function validateChildWorkflowPolicyV2(value: unknown): ChildWorkflowPolicyV2 {
  const policy = validateSkillSchema(ChildWorkflowPolicyV2Schema, value, "ChildWorkflowPolicyV2");
  assertUnique(
    policy.targets.map((target) => target.child_name),
    "ChildWorkflowPolicyV2 child targets"
  );
  if (policy.targets.length === 0 && policy.max_calls !== 0) {
    throw new Error("ChildWorkflowPolicyV2 empty parent policy must reserve zero child calls");
  }
  if (policy.targets.length > 0 && policy.max_calls === 0) {
    throw new Error(
      "ChildWorkflowPolicyV2 allowed child targets require a positive call allowance"
    );
  }
  for (const target of policy.targets) {
    for (const id of [
      target.child_name,
      target.scope_id,
      target.source_policy_id,
      target.destination_policy_id,
    ]) {
      assertOpaqueId(id, "ChildWorkflowPolicyV2 target identity");
    }
    if (target.child_request_schema_id !== "penny.child-workflow-request.v1") {
      throw new Error("ChildWorkflowPolicyV2 only admits the canonical child request schema");
    }
    if (target.child_request_schema_version !== 1) {
      throw new Error("ChildWorkflowPolicyV2 only admits child request schema version 1");
    }
    validateChildWorkflowProgressLeaseBinding(target.progress_lease);
  }
  return policy;
}

export const ChildWorkflowUsageV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    model_turns: Type.Integer({ minimum: 0 }),
    tool_calls: Type.Integer({ minimum: 0 }),
    external_calls: Type.Integer({ minimum: 0 }),
    active_wall_clock_ms: Type.Integer({ minimum: 0 }),
    steps: Type.Integer({ minimum: 0 }),
    output_bytes: Type.Integer({ minimum: 0 }),
    unknown_usage: Type.Boolean(),
  },
  { additionalProperties: false }
);
export type ChildWorkflowUsageV1 = Readonly<Static<typeof ChildWorkflowUsageV1Schema>>;

/** The child result never says that the parent obligation has been satisfied. */
export const ChildWorkflowResultV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    call_id: OpaqueIdSchema,
    parent_run_id: OpaqueIdSchema,
    parent_state_id: OpaqueIdSchema,
    call_key: OpaqueIdSchema,
    child_identity: RunIdentitySchema,
    parent_registration_sha256: Sha256Schema,
    child_registration_sha256: Sha256Schema,
    terminal_action: Type.Union([
      Type.Literal("complete"),
      Type.Literal("incomplete"),
      Type.Literal("error"),
      Type.Literal("cancelled"),
    ]),
    met: Type.Boolean(),
    parent_obligation: Type.Literal("unresolved"),
    terminal_sha256: Sha256Schema,
    output_contract: ChildWorkflowOutputContractV1Schema,
    output_artifact: Type.Union([ArtifactRefSchema, Type.Null()]),
    artifacts: Type.Array(ArtifactRefSchema, { maxItems: MAX_RESULT_ARTIFACTS }),
    usage: ChildWorkflowUsageV1Schema,
  },
  { additionalProperties: false }
);
export type ChildWorkflowResultV1 = Readonly<Static<typeof ChildWorkflowResultV1Schema>>;

export function validateChildWorkflowResult(value: unknown): ChildWorkflowResultV1 {
  const result = validateSkillSchema(ChildWorkflowResultV1Schema, value, "ChildWorkflowResultV1");
  const expectedMet = result.terminal_action === "complete";
  if (result.met !== expectedMet) {
    throw new Error("ChildWorkflowResultV1 terminal action and workflow met truth disagree");
  }
  if (result.child_identity.run_id === result.parent_run_id) {
    throw new Error("ChildWorkflowResultV1 parent and child identities must differ");
  }
  if (result.met && result.output_artifact === null) {
    throw new Error("positive ChildWorkflowResultV1 requires its exact output artifact");
  }
  if (result.output_artifact !== null) {
    assertOutputArtifactMatchesContract(
      result.output_artifact,
      result.output_contract,
      "ChildWorkflowResultV1.output_artifact"
    );
  }
  if (
    result.output_artifact !== null &&
    !result.artifacts.some((artifact) => sameCanonical(artifact, result.output_artifact))
  ) {
    throw new Error("ChildWorkflowResultV1 output is absent from the terminal artifact set");
  }
  return result;
}

/**
 * Initial directives cannot carry a resume response. Only a future trusted owner may construct a
 * separately revalidated reconstruction after it has matched a persisted child-gate record.
 */
export type ChildWorkflowInvocationDirective =
  | InvokeChildWorkflowDirective
  | LeaseBoundInvokeChildWorkflowDirectiveV1;

export function validateInitialChildWorkflowDirective(
  value: unknown
): ChildWorkflowInvocationDirective {
  if (
    value !== null &&
    typeof value === "object" &&
    "schema_version" in value &&
    value.schema_version === 3
  ) {
    return validateLeaseBoundInvokeChildWorkflowDirective(value);
  }
  const directive = validateSkillSchema(
    InvokeChildWorkflowDirectiveSchema,
    value,
    "InvokeChildWorkflowDirective"
  );
  if (directive.resume !== undefined) {
    throw new Error("initial child directive must not contain a resume response");
  }
  return directive;
}

export const ChildWorkflowLifecycleV1Schema = Type.Union([
  Type.Literal("reserved"),
  Type.Literal("running"),
  Type.Literal("waiting_user"),
  Type.Literal("paused"),
  Type.Literal("terminal_recorded"),
  Type.Literal("consumed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);
export type ChildWorkflowLifecycleV1 = Static<typeof ChildWorkflowLifecycleV1Schema>;

/**
 * Runtime schema for the compact v1 call record. CW-03 persists it through the dedicated
 * canonical codec and child-workflow call table; this schema alone grants no dispatch authority.
 */
export const ChildWorkflowCallRecordV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    call_id: OpaqueIdSchema,
    parent_identity: RunIdentitySchema,
    parent_state_id: OpaqueIdSchema,
    parent_visit_sequence: Type.Integer({ minimum: 0 }),
    parent_visit_offset: Type.Integer({ minimum: 0 }),
    call_key: OpaqueIdSchema,
    child_identity: RunIdentitySchema,
    directive: InvokeChildWorkflowDirectiveSchema,
    directive_sha256: Sha256Schema,
    request_ref: ArtifactRefSchema,
    request_ref_sha256: Sha256Schema,
    input_artifacts: InputArtifactsSchema,
    input_refs_sha256: Sha256Schema,
    expected_output: ChildWorkflowOutputContractV1Schema,
    expected_output_sha256: Sha256Schema,
    policy_binding: ChildWorkflowPolicyBindingV1Schema,
    policy_sha256: Sha256Schema,
    parent_registration_sha256: Sha256Schema,
    child_registration_sha256: Sha256Schema,
    budget: ChildWorkflowBudgetAllocationV1Schema,
    lifecycle: ChildWorkflowLifecycleV1Schema,
    terminal_action: Type.Union([
      Type.Literal("complete"),
      Type.Literal("incomplete"),
      Type.Literal("error"),
      Type.Literal("cancelled"),
      Type.Null(),
    ]),
    terminal_sha256: Type.Union([Sha256Schema, Type.Null()]),
    output_artifact: Type.Union([ArtifactRefSchema, Type.Null()]),
    usage: Type.Union([ChildWorkflowUsageV1Schema, Type.Null()]),
    created_at: Rfc3339UtcSchema,
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ChildWorkflowCallRecordV1 = Readonly<Static<typeof ChildWorkflowCallRecordV1Schema>>;

/** New-call durable record. V1 remains byte-exact for historical timing-bound calls. */
export const ChildWorkflowCallRecordV2Schema = Type.Object(
  {
    schema_version: Type.Literal(2),
    call_id: OpaqueIdSchema,
    parent_identity: RunIdentitySchema,
    parent_state_id: OpaqueIdSchema,
    parent_visit_sequence: Type.Integer({ minimum: 0 }),
    parent_visit_offset: Type.Integer({ minimum: 0 }),
    call_key: OpaqueIdSchema,
    child_identity: RunIdentitySchema,
    directive: LeaseBoundInvokeChildWorkflowDirectiveV1Schema,
    directive_sha256: Sha256Schema,
    request_ref: ArtifactRefSchema,
    request_ref_sha256: Sha256Schema,
    input_artifacts: InputArtifactsSchema,
    input_refs_sha256: Sha256Schema,
    expected_output: ChildWorkflowOutputContractV1Schema,
    expected_output_sha256: Sha256Schema,
    policy_binding: ChildWorkflowPolicyBindingV1Schema,
    policy_sha256: Sha256Schema,
    parent_registration_sha256: Sha256Schema,
    child_registration_sha256: Sha256Schema,
    progress_lease: ChildWorkflowProgressLeaseBindingV1Schema,
    lifecycle: ChildWorkflowLifecycleV1Schema,
    terminal_action: Type.Union([
      Type.Literal("complete"),
      Type.Literal("incomplete"),
      Type.Literal("error"),
      Type.Literal("cancelled"),
      Type.Null(),
    ]),
    terminal_sha256: Type.Union([Sha256Schema, Type.Null()]),
    output_artifact: Type.Union([ArtifactRefSchema, Type.Null()]),
    usage: Type.Union([ChildWorkflowUsageV1Schema, Type.Null()]),
    created_at: Rfc3339UtcSchema,
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ChildWorkflowCallRecordV2 = Readonly<Static<typeof ChildWorkflowCallRecordV2Schema>>;
export type ChildWorkflowCallRecord = ChildWorkflowCallRecordV1 | ChildWorkflowCallRecordV2;

function sha256Canonical(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function validateChildWorkflowCallRecord(value: unknown): ChildWorkflowCallRecord {
  const record =
    value !== null &&
    typeof value === "object" &&
    "schema_version" in value &&
    value.schema_version === 2
      ? validateSkillSchema(ChildWorkflowCallRecordV2Schema, value, "ChildWorkflowCallRecordV2")
      : validateSkillSchema(ChildWorkflowCallRecordV1Schema, value, "ChildWorkflowCallRecordV1");
  for (const [label, id] of [
    ["call_id", record.call_id],
    ["parent_run_id", record.parent_identity.run_id],
    ["parent_state_id", record.parent_state_id],
    ["call_key", record.call_key],
    ["child_run_id", record.child_identity.run_id],
  ] as const) {
    assertOpaqueId(id, `ChildWorkflowCallRecordV1.${label}`);
  }
  assertRfc3339Utc(record.created_at, "ChildWorkflowCallRecordV1.created_at");
  assertRfc3339Utc(record.updated_at, "ChildWorkflowCallRecordV1.updated_at");
  if (record.updated_at < record.created_at) {
    throw new Error("ChildWorkflowCallRecordV1 updated_at precedes created_at");
  }
  if (
    record.call_id !==
    childWorkflowCallId({
      parent_run_id: record.parent_identity.run_id,
      parent_state_id: record.parent_state_id,
      call_key: record.call_key,
    })
  ) {
    throw new Error("ChildWorkflowCallRecordV1 call ID does not match its immutable operands");
  }
  const expectedChild = childWorkflowRunIdentity({
    call_id: record.call_id,
    parent: record.parent_identity,
    child_name: record.directive.child_name,
  });
  if (!sameCanonical(record.child_identity, expectedChild)) {
    throw new Error("ChildWorkflowCallRecordV1 child identity does not match immutable operands");
  }
  if (
    record.directive.identity.run_id !== record.parent_identity.run_id ||
    record.directive.state_id !== record.parent_state_id ||
    record.directive.call_key !== record.call_key ||
    !sameCanonical(record.directive.request_ref, record.request_ref) ||
    !sameCanonical(record.directive.input_artifacts, record.input_artifacts) ||
    !sameCanonical(record.directive.expected_output, record.expected_output) ||
    !sameCanonical(record.directive.policy_binding, record.policy_binding) ||
    (record.schema_version === 1 && !sameCanonical(record.directive.budget, record.budget))
  ) {
    throw new Error("ChildWorkflowCallRecord directive does not equal its persisted operands");
  }
  if (
    record.schema_version === 2 &&
    (!sameCanonical(record.directive.progress_lease, record.progress_lease) ||
      record.progress_lease.operation_class !== "child_execution")
  ) {
    throw new Error("ChildWorkflowCallRecordV2 progress lease diverged or has the wrong class");
  }
  if (
    record.directive_sha256 !== childWorkflowDirectiveSha256(record.directive) ||
    record.request_ref_sha256 !== sha256Canonical(record.request_ref) ||
    record.input_refs_sha256 !== sha256Canonical(record.input_artifacts) ||
    record.expected_output_sha256 !== sha256Canonical(record.expected_output) ||
    record.policy_sha256 !== sha256Canonical(record.policy_binding)
  ) {
    throw new Error("ChildWorkflowCallRecordV1 persisted operand digest diverged");
  }
  assertArtifactRefIdentity(record.request_ref, "ChildWorkflowCallRecordV1.request_ref");
  assertUnique(
    record.input_artifacts.artifacts.map((binding) => binding.slot),
    "ChildWorkflowCallRecordV1 input slots"
  );
  for (const binding of record.input_artifacts.artifacts) {
    assertArtifactRefIdentity(binding.ref, "ChildWorkflowCallRecordV1 input artifact");
  }
  const terminal =
    record.lifecycle === "terminal_recorded" ||
    record.lifecycle === "consumed" ||
    record.lifecycle === "failed" ||
    record.lifecycle === "cancelled";
  const terminalFieldsPresent =
    record.terminal_action !== null && record.terminal_sha256 !== null && record.usage !== null;
  if (terminal !== terminalFieldsPresent) {
    throw new Error("ChildWorkflowCallRecordV1 terminal lifecycle and terminal fields disagree");
  }
  if (!terminal && record.output_artifact !== null) {
    throw new Error("ChildWorkflowCallRecordV1 non-terminal lifecycle cannot select an output");
  }
  if (record.terminal_action === "complete" && record.output_artifact === null) {
    throw new Error(
      "ChildWorkflowCallRecordV1 complete terminal requires an exact output artifact"
    );
  }
  if (record.output_artifact !== null) {
    assertOutputArtifactMatchesContract(
      record.output_artifact,
      record.expected_output,
      "ChildWorkflowCallRecordV1.output_artifact"
    );
  }
  return record;
}

export function childWorkflowCallId(input: {
  readonly parent_run_id: string;
  readonly parent_state_id: string;
  readonly call_key: string;
}): string {
  return `child-call-${sha256(canonicalJson(input)).slice(0, 48)}`;
}

export function childWorkflowRunIdentity(input: {
  readonly call_id: string;
  readonly parent: RunIdentity;
  readonly child_name: string;
}): RunIdentity {
  return {
    schema_version: 2,
    run_id: `child-run-${sha256(canonicalJson(input)).slice(0, 48)}`,
    session_id: input.parent.session_id,
    playbook: input.child_name,
    engine_owner: "typescript",
  };
}

export function childWorkflowDirectiveSha256(directive: ChildWorkflowInvocationDirective): string {
  return sha256(canonicalJson(directive));
}

export function childWorkflowPolicyBindingEquals(
  left: ChildWorkflowPolicyBindingV1,
  right: ChildWorkflowPolicyBindingV1
): boolean {
  return sameCanonical(left, right);
}

export function childWorkflowOutputContractEquals(
  left: ChildWorkflowOutputContractV1,
  right: ChildWorkflowOutputContractV1
): boolean {
  return sameCanonical(left, right);
}

export function childBudgetFits(
  allocation: ChildWorkflowBudgetAllocationV1,
  available: ChildWorkflowBudgetCeilingV1
): boolean {
  return budgetAtMost(allocation, available);
}

// CW-01-T2 freezes the next shared contract family without admitting it to current runtime readers.
// Current schema-version-2/3 directives and schema-version-1/2 call records remain unchanged above.

const MAX_PARENT_CHILD_CAPABILITY_BYTES = 1_048_576;
const MAX_HOST_AUTHORITY_BYTES = 262_144;
const MAX_ROOT_NON_TIME_ENVELOPE_BYTES = 262_144;
const MAX_CHILD_RESOURCE_RESERVATION_BYTES = 131_072;
const MAX_CHILD_DIRECTIVE_V4_BYTES = 262_144;
const MAX_PENDING_CHILD_GATE_BYTES = 131_072;
const MAX_ACCEPTED_CHILD_RESULT_BYTES = 131_072;
const MAX_CHILD_CALL_V3_BYTES = 524_288;
const MAX_QUALIFICATION_MANIFEST_BYTES = 4_194_304;
const MAX_AUTHORITY_BINDINGS = 32;
const MAX_AUTHORITY_APPROVALS = 32;
const MAX_QUALIFICATION_EVIDENCE_REFS = 128;
const MAX_NON_TIME_RESOURCE_VALUE = Number.MAX_SAFE_INTEGER;

const NonTimeResourceValueSchema = Type.Integer({
  minimum: 0,
  maximum: MAX_NON_TIME_RESOURCE_VALUE,
});

/** Finite, non-time resource quantities. Money is represented as integer micro-US-dollars. */
export const ChildNonTimeResourceVectorV1Schema = Type.Object(
  {
    model_calls: NonTimeResourceValueSchema,
    model_turns: NonTimeResourceValueSchema,
    model_input_tokens: NonTimeResourceValueSchema,
    model_output_tokens: NonTimeResourceValueSchema,
    priced_usage_microusd: NonTimeResourceValueSchema,
    tool_calls: NonTimeResourceValueSchema,
    external_requests: NonTimeResourceValueSchema,
    steps: NonTimeResourceValueSchema,
    input_artifacts: NonTimeResourceValueSchema,
    output_artifacts: NonTimeResourceValueSchema,
    retained_artifacts: NonTimeResourceValueSchema,
    input_bytes: NonTimeResourceValueSchema,
    output_bytes: NonTimeResourceValueSchema,
    retained_bytes: NonTimeResourceValueSchema,
  },
  { additionalProperties: false }
);
export type ChildNonTimeResourceVectorV1 = Readonly<
  Static<typeof ChildNonTimeResourceVectorV1Schema>
>;

export const ChildFinalOutputCapacityV1Schema = Type.Object(
  {
    child_result_bytes: Type.Integer({ minimum: 1, maximum: MAX_NON_TIME_RESOURCE_VALUE }),
    receipt_control_bytes: Type.Integer({ minimum: 1, maximum: MAX_NON_TIME_RESOURCE_VALUE }),
    parent_sealing_bytes: Type.Integer({ minimum: 1, maximum: MAX_NON_TIME_RESOURCE_VALUE }),
  },
  { additionalProperties: false }
);
export type ChildFinalOutputCapacityV1 = Readonly<Static<typeof ChildFinalOutputCapacityV1Schema>>;

const PolicyCapabilityDigestV1Schema = Type.Object(
  {
    capability_id: OpaqueIdSchema,
    capability_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const ParentChildCapabilityTargetV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    child_name: OpaqueIdSchema,
    provider_descriptor_sha256: Sha256Schema,
    provider_request_schema_id: SchemaIdSchema,
    provider_request_schema_version: Type.Integer({ minimum: 1 }),
    expected_output: ChildWorkflowOutputContractV1Schema,
    authority_policy_id: OpaqueIdSchema,
    authority_policy_sha256: Sha256Schema,
    allocation_policy_id: OpaqueIdSchema,
    allocation_policy_sha256: Sha256Schema,
    progress_lease: ChildWorkflowProgressLeaseBindingV1Schema,
  },
  { additionalProperties: false }
);
export type ParentChildCapabilityTargetV1 = Readonly<
  Static<typeof ParentChildCapabilityTargetV1Schema>
>;

const ParentChildCapabilityPolicyBaseV1 = {
  schema_id: Type.Literal("penny.parent-child-capability-policy.v1"),
  schema_version: Type.Literal(1),
  policy_id: OpaqueIdSchema,
  parent_registration_sha256: Sha256Schema,
  topology: Type.Object(
    {
      nesting_depth: Type.Literal(1),
      max_active_children_per_parent: Type.Literal(1),
      project_concurrency_limit: Type.Literal(1),
    },
    { additionalProperties: false }
  ),
};

/**
 * Parent-owned child capability. The zero-call variant is the universal default; a parent must
 * explicitly register a bounded target set before it can request any child execution.
 */
export const ParentChildCapabilityPolicyV1Schema = Type.Union([
  Type.Object(
    {
      ...ParentChildCapabilityPolicyBaseV1,
      max_calls: Type.Literal(0),
      root_resource_policy_sha256: Type.Null(),
      targets: Type.Array(ParentChildCapabilityTargetV1Schema, { maxItems: 0 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...ParentChildCapabilityPolicyBaseV1,
      max_calls: Type.Integer({ minimum: 1, maximum: MAX_POLICY_CALLS }),
      root_resource_policy_sha256: Sha256Schema,
      targets: Type.Array(ParentChildCapabilityTargetV1Schema, {
        minItems: 1,
        maxItems: MAX_POLICY_TARGETS,
      }),
    },
    { additionalProperties: false }
  ),
]);
export type ParentChildCapabilityPolicyV1 = Readonly<
  Static<typeof ParentChildCapabilityPolicyV1Schema>
>;

export function validateParentChildCapabilityPolicy(value: unknown): ParentChildCapabilityPolicyV1 {
  const policy = validateSkillSchema(
    ParentChildCapabilityPolicyV1Schema,
    value,
    "ParentChildCapabilityPolicyV1"
  );
  assertOpaqueId(policy.policy_id, "ParentChildCapabilityPolicyV1.policy_id");
  assertUnique(
    policy.targets.map((target) => target.child_name),
    "ParentChildCapabilityPolicyV1 target child names"
  );
  for (const target of policy.targets) {
    assertOpaqueId(target.child_name, "ParentChildCapabilityPolicyV1 target child_name");
    assertOpaqueId(
      target.authority_policy_id,
      "ParentChildCapabilityPolicyV1 target authority_policy_id"
    );
    assertOpaqueId(
      target.allocation_policy_id,
      "ParentChildCapabilityPolicyV1 target allocation_policy_id"
    );
    if (target.progress_lease.operation_class !== "child_execution") {
      throw new Error(
        "ParentChildCapabilityPolicyV1 target progress lease must use child_execution"
      );
    }
  }
  assertCanonicalBytesAtMost(
    policy,
    "ParentChildCapabilityPolicyV1",
    MAX_PARENT_CHILD_CAPABILITY_BYTES
  );
  return policy;
}

/** Immutable host-minted authority facts. Identifiers and digests never grant authority alone. */
export const HostAuthorityBindingV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.host-authority-binding.v1"),
    schema_version: Type.Literal(1),
    authority_id: OpaqueIdSchema,
    issuer: Type.Literal("trusted_host"),
    operation: Type.Literal("invoke_child_workflow"),
    parent_run_id: OpaqueIdSchema,
    parent_state_id: OpaqueIdSchema,
    parent_state_visit: Type.Integer({ minimum: 1 }),
    call_offset: Type.Integer({ minimum: 0 }),
    call_key: OpaqueIdSchema,
    child_name: OpaqueIdSchema,
    parent_registration_sha256: Sha256Schema,
    provider_descriptor_sha256: Sha256Schema,
    parent_policy_sha256: Sha256Schema,
    policy_binding: ChildWorkflowPolicyBindingV1Schema,
    source_capabilities: Type.Array(PolicyCapabilityDigestV1Schema, {
      minItems: 1,
      maxItems: MAX_AUTHORITY_BINDINGS,
    }),
    destination_capabilities: Type.Array(PolicyCapabilityDigestV1Schema, {
      minItems: 1,
      maxItems: MAX_AUTHORITY_BINDINGS,
    }),
    consequence_capabilities: Type.Array(PolicyCapabilityDigestV1Schema, {
      maxItems: MAX_AUTHORITY_BINDINGS,
    }),
    approval_policy: PolicyCapabilityDigestV1Schema,
    approval_refs: Type.Array(ArtifactRefSchema, { maxItems: MAX_AUTHORITY_APPROVALS }),
    issued_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type HostAuthorityBindingV1 = Readonly<Static<typeof HostAuthorityBindingV1Schema>>;

export function validateHostAuthorityBinding(value: unknown): HostAuthorityBindingV1 {
  const binding = validateSkillSchema(
    HostAuthorityBindingV1Schema,
    value,
    "HostAuthorityBindingV1"
  );
  assertOpaqueId(binding.authority_id, "HostAuthorityBindingV1.authority_id");
  for (const [label, item] of [
    ["parent_run_id", binding.parent_run_id],
    ["parent_state_id", binding.parent_state_id],
    ["call_key", binding.call_key],
    ["child_name", binding.child_name],
  ] as const) {
    assertOpaqueId(item, `HostAuthorityBindingV1.${label}`);
  }
  for (const [label, item] of [
    ["project_id", binding.policy_binding.project_id],
    ["principal_id", binding.policy_binding.principal_id],
    ["scope_id", binding.policy_binding.scope_id],
    ["source_policy_id", binding.policy_binding.source_policy_id],
    ["destination_policy_id", binding.policy_binding.destination_policy_id],
  ] as const) {
    assertOpaqueId(item, `HostAuthorityBindingV1.policy_binding.${label}`);
  }
  for (const [label, capabilities] of [
    ["source", binding.source_capabilities],
    ["destination", binding.destination_capabilities],
    ["consequence", binding.consequence_capabilities],
  ] as const) {
    assertUnique(
      capabilities.map((item) => item.capability_id),
      `HostAuthorityBindingV1 ${label} capability IDs`
    );
    for (const capability of capabilities) {
      assertOpaqueId(capability.capability_id, `HostAuthorityBindingV1 ${label} capability_id`);
    }
  }
  if (
    !binding.source_capabilities.some(
      (item) => item.capability_id === binding.policy_binding.source_policy_id
    )
  ) {
    throw new Error("HostAuthorityBindingV1 source policy lacks a bound capability");
  }
  if (
    !binding.destination_capabilities.some(
      (item) => item.capability_id === binding.policy_binding.destination_policy_id
    )
  ) {
    throw new Error("HostAuthorityBindingV1 destination policy lacks a bound capability");
  }
  if (binding.consequence_capabilities.length > 0 && binding.approval_refs.length === 0) {
    throw new Error("HostAuthorityBindingV1 consequential authority requires approval evidence");
  }
  assertOpaqueId(
    binding.approval_policy.capability_id,
    "HostAuthorityBindingV1.approval_policy.capability_id"
  );
  assertRfc3339Utc(binding.issued_at, "HostAuthorityBindingV1.issued_at");
  assertArtifactRefsIdentity(binding.approval_refs, "HostAuthorityBindingV1.approval_refs");
  assertCanonicalBytesAtMost(binding, "HostAuthorityBindingV1", MAX_HOST_AUTHORITY_BYTES);
  return binding;
}

/** Finite root envelope for one parent run. No total-duration or wall-clock budget appears here. */
export const RootNonTimeEnvelopeV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.root-non-time-envelope.v1"),
    schema_version: Type.Literal(1),
    envelope_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    principal_id: OpaqueIdSchema,
    scope_id: OpaqueIdSchema,
    authority_sha256: Sha256Schema,
    resource_policy_id: OpaqueIdSchema,
    resource_policy_sha256: Sha256Schema,
    topology: Type.Object(
      {
        nesting_depth: Type.Literal(1),
        max_active_children_per_parent: Type.Literal(1),
        project_concurrency_limit: Type.Literal(1),
      },
      { additionalProperties: false }
    ),
    max_child_calls: Type.Integer({ minimum: 1, maximum: MAX_POLICY_CALLS }),
    limits: ChildNonTimeResourceVectorV1Schema,
    final_output_capacity: ChildFinalOutputCapacityV1Schema,
    issued_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type RootNonTimeEnvelopeV1 = Readonly<Static<typeof RootNonTimeEnvelopeV1Schema>>;

const NON_TIME_RESOURCE_FIELDS = [
  "model_calls",
  "model_turns",
  "model_input_tokens",
  "model_output_tokens",
  "priced_usage_microusd",
  "tool_calls",
  "external_requests",
  "steps",
  "input_artifacts",
  "output_artifacts",
  "retained_artifacts",
  "input_bytes",
  "output_bytes",
  "retained_bytes",
] as const;

const FINAL_OUTPUT_FIELDS = [
  "child_result_bytes",
  "receipt_control_bytes",
  "parent_sealing_bytes",
] as const;

function sumFinalOutput(value: ChildFinalOutputCapacityV1): number {
  const total = FINAL_OUTPUT_FIELDS.reduce((sum, field) => sum + value[field], 0);
  if (!Number.isSafeInteger(total)) {
    throw new Error("Child final-output capacity exceeds safe integer range");
  }
  return total;
}

function vectorAtMost(
  candidate: ChildNonTimeResourceVectorV1,
  ceiling: ChildNonTimeResourceVectorV1
): boolean {
  return NON_TIME_RESOURCE_FIELDS.every((field) => candidate[field] <= ceiling[field]);
}

function finalOutputAtMost(
  candidate: ChildFinalOutputCapacityV1,
  ceiling: ChildFinalOutputCapacityV1
): boolean {
  return FINAL_OUTPUT_FIELDS.every((field) => candidate[field] <= ceiling[field]);
}

function vectorIsZero(value: ChildNonTimeResourceVectorV1): boolean {
  return NON_TIME_RESOURCE_FIELDS.every((field) => value[field] === 0);
}

function finalOutputIsZero(value: ChildFinalOutputUsageV1): boolean {
  return FINAL_OUTPUT_FIELDS.every((field) => value[field] === 0);
}

export function validateRootNonTimeEnvelope(value: unknown): RootNonTimeEnvelopeV1 {
  const envelope = validateSkillSchema(RootNonTimeEnvelopeV1Schema, value, "RootNonTimeEnvelopeV1");
  for (const [label, item] of [
    ["envelope_id", envelope.envelope_id],
    ["project_id", envelope.project_id],
    ["principal_id", envelope.principal_id],
    ["scope_id", envelope.scope_id],
    ["resource_policy_id", envelope.resource_policy_id],
  ] as const) {
    assertOpaqueId(item, `RootNonTimeEnvelopeV1.${label}`);
  }
  const finalOutputBytes = sumFinalOutput(envelope.final_output_capacity);
  if (
    finalOutputBytes > envelope.limits.output_bytes ||
    finalOutputBytes > envelope.limits.retained_bytes
  ) {
    throw new Error(
      "RootNonTimeEnvelopeV1 final-output capacity exceeds output or retention capacity"
    );
  }
  assertRfc3339Utc(envelope.issued_at, "RootNonTimeEnvelopeV1.issued_at");
  assertCanonicalBytesAtMost(envelope, "RootNonTimeEnvelopeV1", MAX_ROOT_NON_TIME_ENVELOPE_BYTES);
  return envelope;
}

export function rootNonTimeEnvelopeSha256(envelope: RootNonTimeEnvelopeV1): string {
  return sha256(canonicalJson(validateRootNonTimeEnvelope(envelope)));
}

const ChildFinalOutputUsageV1Schema = Type.Object(
  {
    child_result_bytes: NonTimeResourceValueSchema,
    receipt_control_bytes: NonTimeResourceValueSchema,
    parent_sealing_bytes: NonTimeResourceValueSchema,
  },
  { additionalProperties: false }
);
type ChildFinalOutputUsageV1 = Readonly<Static<typeof ChildFinalOutputUsageV1Schema>>;

/** Immutable, root-ledger-fenced per-attempt reservation made before a child starts. */
export const ChildResourceReservationV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.child-resource-reservation.v1"),
    schema_version: Type.Literal(1),
    reservation_id: OpaqueIdSchema,
    root_envelope_id: OpaqueIdSchema,
    root_envelope_sha256: Sha256Schema,
    root_call_ordinal: Type.Integer({ minimum: 1, maximum: MAX_POLICY_CALLS }),
    root_account_sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    root_account_fence_sha256: Sha256Schema,
    call_key: OpaqueIdSchema,
    attempt_id: OpaqueIdSchema,
    allocation: ChildNonTimeResourceVectorV1Schema,
    remaining_before: ChildNonTimeResourceVectorV1Schema,
    remaining_after: ChildNonTimeResourceVectorV1Schema,
    final_output_reserve: ChildFinalOutputCapacityV1Schema,
    final_output_remaining_before: ChildFinalOutputUsageV1Schema,
    final_output_remaining_after: ChildFinalOutputUsageV1Schema,
  },
  { additionalProperties: false }
);
export type ChildResourceReservationV1 = Readonly<Static<typeof ChildResourceReservationV1Schema>>;

export function validateChildResourceReservation(value: unknown): ChildResourceReservationV1 {
  const reservation = validateSkillSchema(
    ChildResourceReservationV1Schema,
    value,
    "ChildResourceReservationV1"
  );
  for (const [label, item] of [
    ["reservation_id", reservation.reservation_id],
    ["root_envelope_id", reservation.root_envelope_id],
    ["call_key", reservation.call_key],
    ["attempt_id", reservation.attempt_id],
  ] as const) {
    assertOpaqueId(item, `ChildResourceReservationV1.${label}`);
  }
  for (const field of NON_TIME_RESOURCE_FIELDS) {
    const expectedAfter = reservation.remaining_before[field] - reservation.allocation[field];
    if (
      !Number.isSafeInteger(expectedAfter) ||
      expectedAfter < 0 ||
      expectedAfter !== reservation.remaining_after[field]
    ) {
      throw new Error(`ChildResourceReservationV1 ${field} does not record an exact debit`);
    }
  }
  for (const field of FINAL_OUTPUT_FIELDS) {
    const expectedAfter =
      reservation.final_output_remaining_before[field] - reservation.final_output_reserve[field];
    if (
      !Number.isSafeInteger(expectedAfter) ||
      expectedAfter < 0 ||
      expectedAfter !== reservation.final_output_remaining_after[field]
    ) {
      throw new Error(`ChildResourceReservationV1 final ${field} does not record an exact debit`);
    }
  }
  assertCanonicalBytesAtMost(
    reservation,
    "ChildResourceReservationV1",
    MAX_CHILD_RESOURCE_RESERVATION_BYTES
  );
  return reservation;
}

export function childResourceReservationFitsRoot(input: {
  readonly reservation: ChildResourceReservationV1;
  readonly root: RootNonTimeEnvelopeV1;
}): boolean {
  const reservation = validateChildResourceReservation(input.reservation);
  const root = validateRootNonTimeEnvelope(input.root);
  return (
    reservation.root_envelope_id === root.envelope_id &&
    reservation.root_envelope_sha256 === rootNonTimeEnvelopeSha256(root) &&
    reservation.root_call_ordinal <= root.max_child_calls &&
    vectorAtMost(reservation.remaining_before, root.limits) &&
    finalOutputAtMost(reservation.final_output_remaining_before, root.final_output_capacity)
  );
}

/** Durable charged/uncertain/released accounting for one immutable reservation. */
export const ChildResourceSettlementV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.child-resource-settlement.v1"),
    schema_version: Type.Literal(1),
    reservation_id: OpaqueIdSchema,
    root_account_sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    root_account_fence_sha256: Sha256Schema,
    state: Type.Union([Type.Literal("open"), Type.Literal("settled")]),
    charged: ChildNonTimeResourceVectorV1Schema,
    uncertain: ChildNonTimeResourceVectorV1Schema,
    released: ChildNonTimeResourceVectorV1Schema,
    final_output_charged: ChildFinalOutputUsageV1Schema,
    final_output_uncertain: ChildFinalOutputUsageV1Schema,
    final_output_released: ChildFinalOutputUsageV1Schema,
    settlement_id: Type.Union([OpaqueIdSchema, Type.Null()]),
    settled_at: Type.Union([Rfc3339UtcSchema, Type.Null()]),
  },
  { additionalProperties: false }
);
export type ChildResourceSettlementV1 = Readonly<Static<typeof ChildResourceSettlementV1Schema>>;

export function validateChildResourceSettlement(value: unknown): ChildResourceSettlementV1 {
  const settlement = validateSkillSchema(
    ChildResourceSettlementV1Schema,
    value,
    "ChildResourceSettlementV1"
  );
  assertOpaqueId(settlement.reservation_id, "ChildResourceSettlementV1.reservation_id");
  if (settlement.state === "open") {
    if (
      settlement.settlement_id !== null ||
      settlement.settled_at !== null ||
      !vectorIsZero(settlement.released) ||
      !finalOutputIsZero(settlement.final_output_released)
    ) {
      throw new Error("ChildResourceSettlementV1 open state cannot release or settle");
    }
  } else {
    if (settlement.settlement_id === null || settlement.settled_at === null) {
      throw new Error("ChildResourceSettlementV1 settled state requires identity and time");
    }
    assertOpaqueId(settlement.settlement_id, "ChildResourceSettlementV1.settlement_id");
    assertRfc3339Utc(settlement.settled_at, "ChildResourceSettlementV1.settled_at");
  }
  assertCanonicalBytesAtMost(
    settlement,
    "ChildResourceSettlementV1",
    MAX_CHILD_RESOURCE_RESERVATION_BYTES
  );
  return settlement;
}

function assertResourceSums(
  settlement: ChildResourceSettlementV1,
  reservation: ChildResourceReservationV1
): void {
  for (const field of NON_TIME_RESOURCE_FIELDS) {
    const accounted =
      settlement.charged[field] + settlement.uncertain[field] + settlement.released[field];
    if (!Number.isSafeInteger(accounted) || accounted > reservation.allocation[field]) {
      throw new Error(`ChildResourceSettlementV1 ${field} exceeds its reservation`);
    }
    if (settlement.state === "settled" && accounted !== reservation.allocation[field]) {
      throw new Error(`ChildResourceSettlementV1 settled ${field} is not fully accounted`);
    }
  }
  for (const field of FINAL_OUTPUT_FIELDS) {
    const accounted =
      settlement.final_output_charged[field] +
      settlement.final_output_uncertain[field] +
      settlement.final_output_released[field];
    if (!Number.isSafeInteger(accounted) || accounted > reservation.final_output_reserve[field]) {
      throw new Error(`ChildResourceSettlementV1 final ${field} exceeds its reservation`);
    }
    if (settlement.state === "settled" && accounted !== reservation.final_output_reserve[field]) {
      throw new Error(`ChildResourceSettlementV1 settled final ${field} is not fully accounted`);
    }
  }
}

export function validateChildResourceSettlementAgainstReservation(input: {
  readonly settlement: unknown;
  readonly reservation: ChildResourceReservationV1;
}): ChildResourceSettlementV1 {
  const reservation = validateChildResourceReservation(input.reservation);
  const settlement = validateChildResourceSettlement(input.settlement);
  if (settlement.reservation_id !== reservation.reservation_id) {
    throw new Error("ChildResourceSettlementV1 reservation identity mismatch");
  }
  if (settlement.state === "open") {
    if (
      settlement.root_account_sequence !== reservation.root_account_sequence ||
      settlement.root_account_fence_sha256 !== reservation.root_account_fence_sha256
    ) {
      throw new Error("ChildResourceSettlementV1 open state lost its root ledger fence");
    }
  } else if (settlement.root_account_sequence <= reservation.root_account_sequence) {
    throw new Error("ChildResourceSettlementV1 settlement did not advance the root ledger");
  }
  assertResourceSums(settlement, reservation);
  return settlement;
}

/**
 * Version-4 initial directive. This closed contract is not part of DirectiveSchema yet, so adding
 * it cannot admit new runtime behavior before the separately reviewed registry/runtime tasks.
 */
export const InvokeChildWorkflowDirectiveV4Schema = Type.Object(
  {
    schema_version: Type.Literal(4),
    action: Type.Literal("invoke_child_workflow"),
    identity: RunIdentitySchema,
    state_id: OpaqueIdSchema,
    parent_state_visit: Type.Integer({ minimum: 1 }),
    call_offset: Type.Integer({ minimum: 0 }),
    call_key: OpaqueIdSchema,
    child_name: OpaqueIdSchema,
    parent_registration_sha256: Sha256Schema,
    child_registration_sha256: Sha256Schema,
    parent_policy_sha256: Sha256Schema,
    provider_descriptor_sha256: Sha256Schema,
    request_ref: ArtifactRefSchema,
    input_artifacts: InputArtifactsSchema,
    expected_output: ChildWorkflowOutputContractV1Schema,
    policy_binding: ChildWorkflowPolicyBindingV1Schema,
    authority: HostAuthorityBindingV1Schema,
    authority_sha256: Sha256Schema,
    root_envelope: RootNonTimeEnvelopeV1Schema,
    root_envelope_sha256: Sha256Schema,
    reservation: ChildResourceReservationV1Schema,
    reservation_sha256: Sha256Schema,
    progress_lease: ChildWorkflowProgressLeaseBindingV1Schema,
  },
  { additionalProperties: false }
);
export type InvokeChildWorkflowDirectiveV4 = Readonly<
  Static<typeof InvokeChildWorkflowDirectiveV4Schema>
>;

export function validateInvokeChildWorkflowDirectiveV4(
  value: unknown
): InvokeChildWorkflowDirectiveV4 {
  const directive = validateSkillSchema(
    InvokeChildWorkflowDirectiveV4Schema,
    value,
    "InvokeChildWorkflowDirectiveV4"
  );
  const authority = validateHostAuthorityBinding(directive.authority);
  const root = validateRootNonTimeEnvelope(directive.root_envelope);
  const reservation = validateChildResourceReservation(directive.reservation);
  assertArtifactRefIdentity(directive.request_ref, "InvokeChildWorkflowDirectiveV4.request_ref");
  if (
    directive.request_ref.kind !== "child-request" ||
    directive.request_ref.content_schema?.schema_id !== "penny.child-workflow-request.v1" ||
    directive.request_ref.content_schema.schema_version !== 1
  ) {
    throw new Error("InvokeChildWorkflowDirectiveV4 request_ref has the wrong exact contract");
  }
  directive.input_artifacts.artifacts.forEach((input, index) =>
    assertArtifactRefIdentity(
      input.ref,
      `InvokeChildWorkflowDirectiveV4.input_artifacts.artifacts[${index}].ref`
    )
  );
  assertUnique(
    directive.input_artifacts.artifacts.map((input) => input.slot),
    "InvokeChildWorkflowDirectiveV4 input slots"
  );
  if (directive.progress_lease.operation_class !== "child_execution") {
    throw new Error("InvokeChildWorkflowDirectiveV4 progress lease must use child_execution");
  }
  if (
    authority.parent_run_id !== directive.identity.run_id ||
    authority.parent_state_id !== directive.state_id ||
    authority.parent_state_visit !== directive.parent_state_visit ||
    authority.call_offset !== directive.call_offset ||
    authority.call_key !== directive.call_key ||
    authority.child_name !== directive.child_name ||
    authority.parent_registration_sha256 !== directive.parent_registration_sha256 ||
    authority.provider_descriptor_sha256 !== directive.provider_descriptor_sha256 ||
    authority.parent_policy_sha256 !== directive.parent_policy_sha256 ||
    !sameCanonical(authority.policy_binding, directive.policy_binding)
  ) {
    throw new Error("InvokeChildWorkflowDirectiveV4 authority binding mismatch");
  }
  const authoritySha256 = sha256(canonicalJson(authority));
  if (directive.authority_sha256 !== authoritySha256 || root.authority_sha256 !== authoritySha256) {
    throw new Error("InvokeChildWorkflowDirectiveV4 authority digest mismatch");
  }
  const rootSha256 = rootNonTimeEnvelopeSha256(root);
  if (directive.root_envelope_sha256 !== rootSha256) {
    throw new Error("InvokeChildWorkflowDirectiveV4 root envelope digest mismatch");
  }
  if (
    root.project_id !== directive.policy_binding.project_id ||
    root.principal_id !== directive.policy_binding.principal_id ||
    root.scope_id !== directive.policy_binding.scope_id
  ) {
    throw new Error("InvokeChildWorkflowDirectiveV4 root authority scope mismatch");
  }
  if (
    reservation.call_key !== directive.call_key ||
    !childResourceReservationFitsRoot({ reservation, root })
  ) {
    throw new Error("InvokeChildWorkflowDirectiveV4 reservation exceeds or mismatches its root");
  }
  if (directive.reservation_sha256 !== sha256(canonicalJson(reservation))) {
    throw new Error("InvokeChildWorkflowDirectiveV4 reservation digest mismatch");
  }
  assertCanonicalBytesAtMost(
    directive,
    "InvokeChildWorkflowDirectiveV4",
    MAX_CHILD_DIRECTIVE_V4_BYTES
  );
  return directive;
}

/** Durable user-gate state bound to the current fenced child owner. */
export const PendingChildGateV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.pending-child-gate.v1"),
    schema_version: Type.Literal(1),
    call_id: OpaqueIdSchema,
    child_run_id: OpaqueIdSchema,
    gate_id: OpaqueIdSchema,
    challenge_id: OpaqueIdSchema,
    payload_sha256: Sha256Schema,
    fence: ChildWorkflowExecutionFenceV1Schema,
    state: Type.Union([Type.Literal("pending"), Type.Literal("resolved")]),
    response_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    operator_evidence_refs: Type.Array(ArtifactRefSchema, {
      maxItems: MAX_AUTHORITY_APPROVALS,
    }),
    recorded_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type PendingChildGateV1 = Readonly<Static<typeof PendingChildGateV1Schema>>;

export function validatePendingChildGate(value: unknown): PendingChildGateV1 {
  const gate = validateSkillSchema(PendingChildGateV1Schema, value, "PendingChildGateV1");
  for (const [label, item] of [
    ["call_id", gate.call_id],
    ["child_run_id", gate.child_run_id],
    ["gate_id", gate.gate_id],
    ["challenge_id", gate.challenge_id],
  ] as const) {
    assertOpaqueId(item, `PendingChildGateV1.${label}`);
  }
  validateChildWorkflowExecutionFence(gate.fence);
  if (gate.state === "pending" && gate.response_ref !== null) {
    throw new Error("PendingChildGateV1 pending gate cannot have a response");
  }
  if (gate.state === "resolved" && gate.response_ref === null) {
    throw new Error("PendingChildGateV1 resolved gate requires a response");
  }
  if (gate.response_ref !== null) {
    assertArtifactRefIdentity(gate.response_ref, "PendingChildGateV1.response_ref");
  }
  assertArtifactRefsIdentity(
    gate.operator_evidence_refs,
    "PendingChildGateV1.operator_evidence_refs"
  );
  assertRfc3339Utc(gate.recorded_at, "PendingChildGateV1.recorded_at");
  assertCanonicalBytesAtMost(gate, "PendingChildGateV1", MAX_PENDING_CHILD_GATE_BYTES);
  return gate;
}

/**
 * Exact parent acceptance of an immutable child result. It explicitly does not satisfy the
 * parent's own completion or downstream evidence obligations.
 */
export const AcceptedChildResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.accepted-child-result.v1"),
    schema_version: Type.Literal(1),
    acceptance_id: OpaqueIdSchema,
    call_id: OpaqueIdSchema,
    parent_run_id: OpaqueIdSchema,
    parent_state_id: OpaqueIdSchema,
    child_run_id: OpaqueIdSchema,
    fence: ChildWorkflowExecutionFenceV1Schema,
    disposition: Type.Union([Type.Literal("accepted"), Type.Literal("rejected")]),
    child_result_ref: ArtifactRefSchema,
    terminal_envelope_sha256: Sha256Schema,
    semantic_output_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    invocation_receipt_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 32 }),
    completion_receipt_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 32 }),
    settlement_id: OpaqueIdSchema,
    rejection_reason: Type.Union([
      Type.Null(),
      TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
    ]),
    satisfies_parent_obligation: Type.Literal(false),
    recorded_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type AcceptedChildResultV1 = Readonly<Static<typeof AcceptedChildResultV1Schema>>;

export function validateAcceptedChildResult(value: unknown): AcceptedChildResultV1 {
  const result = validateSkillSchema(AcceptedChildResultV1Schema, value, "AcceptedChildResultV1");
  for (const [label, item] of [
    ["acceptance_id", result.acceptance_id],
    ["call_id", result.call_id],
    ["parent_run_id", result.parent_run_id],
    ["parent_state_id", result.parent_state_id],
    ["child_run_id", result.child_run_id],
    ["settlement_id", result.settlement_id],
  ] as const) {
    assertOpaqueId(item, `AcceptedChildResultV1.${label}`);
  }
  validateChildWorkflowExecutionFence(result.fence);
  assertArtifactRefIdentity(result.child_result_ref, "AcceptedChildResultV1.child_result_ref");
  if (
    result.child_result_ref.kind !== "child-result" ||
    result.child_result_ref.content_schema?.schema_id !== "penny.child-workflow-result.v1" ||
    result.child_result_ref.content_schema.schema_version !== 1
  ) {
    throw new Error("AcceptedChildResultV1 child_result_ref has the wrong exact contract");
  }
  if (result.semantic_output_ref !== null) {
    assertArtifactRefIdentity(
      result.semantic_output_ref,
      "AcceptedChildResultV1.semantic_output_ref"
    );
  }
  assertArtifactRefsIdentity(
    result.invocation_receipt_refs,
    "AcceptedChildResultV1.invocation_receipt_refs"
  );
  assertArtifactRefsIdentity(
    result.completion_receipt_refs,
    "AcceptedChildResultV1.completion_receipt_refs"
  );
  if (
    result.invocation_receipt_refs.some((ref) => ref.kind !== "child-invocation-receipt") ||
    result.completion_receipt_refs.some((ref) => ref.kind !== "child-completion-receipt")
  ) {
    throw new Error("AcceptedChildResultV1 receipt refs have the wrong exact kinds");
  }
  if (result.disposition === "accepted") {
    if (result.semantic_output_ref === null || result.rejection_reason !== null) {
      throw new Error(
        "AcceptedChildResultV1 accepted disposition requires output and no rejection reason"
      );
    }
  } else {
    if (result.rejection_reason === null) {
      throw new Error("AcceptedChildResultV1 rejected disposition requires a reason");
    }
    assertText(result.rejection_reason, "AcceptedChildResultV1.rejection_reason", {
      minBytes: 1,
      maxBytes: 4_096,
      multiline: true,
    });
  }
  assertRfc3339Utc(result.recorded_at, "AcceptedChildResultV1.recorded_at");
  assertCanonicalBytesAtMost(result, "AcceptedChildResultV1", MAX_ACCEPTED_CHILD_RESULT_BYTES);
  return result;
}

/** Exact qualification inputs and evidence; model-visible discovery still requires operator action. */
export const ChildProviderQualificationManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.child-provider-qualification-manifest.v1"),
    schema_version: Type.Literal(1),
    manifest_id: OpaqueIdSchema,
    provider_name: OpaqueIdSchema,
    status: Type.Union([
      Type.Literal("candidate"),
      Type.Literal("qualification_running"),
      Type.Literal("qualified_non_discoverable"),
      Type.Literal("discoverable"),
      Type.Literal("stale"),
      Type.Literal("withdrawn"),
    ]),
    code_revision: Type.String({ minLength: 7, maxLength: 128, pattern: "^[a-f0-9]+$" }),
    bindings: Type.Object(
      {
        parent_contracts_sha256: Sha256Schema,
        provider_descriptor_sha256: Sha256Schema,
        validator_sha256: Sha256Schema,
        guidance_sha256: Sha256Schema,
        tool_contract_sha256: Sha256Schema,
        non_time_policy_sha256: Sha256Schema,
        progress_lease_policy_sha256: Sha256Schema,
        fixture_set_sha256: Sha256Schema,
        environment_manifest_sha256: Sha256Schema,
        provider_profile_sha256: Sha256Schema,
      },
      { additionalProperties: false }
    ),
    evidence_refs: Type.Array(ArtifactRefSchema, {
      maxItems: MAX_QUALIFICATION_EVIDENCE_REFS,
    }),
    independent_verification_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    operator_decision_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    state_reason: Type.Union([
      Type.Null(),
      TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
    ]),
    recorded_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ChildProviderQualificationManifestV1 = Readonly<
  Static<typeof ChildProviderQualificationManifestV1Schema>
>;

export function validateChildProviderQualificationManifest(
  value: unknown
): ChildProviderQualificationManifestV1 {
  const manifest = validateSkillSchema(
    ChildProviderQualificationManifestV1Schema,
    value,
    "ChildProviderQualificationManifestV1"
  );
  assertOpaqueId(manifest.manifest_id, "ChildProviderQualificationManifestV1.manifest_id");
  assertOpaqueId(manifest.provider_name, "ChildProviderQualificationManifestV1.provider_name");
  assertArtifactRefsIdentity(
    manifest.evidence_refs,
    "ChildProviderQualificationManifestV1.evidence_refs"
  );
  if (manifest.evidence_refs.some((ref) => ref.kind !== "child-provider-qualification-evidence")) {
    throw new Error("ChildProviderQualificationManifestV1 evidence refs have the wrong exact kind");
  }
  if (manifest.independent_verification_ref !== null) {
    assertArtifactRefIdentity(
      manifest.independent_verification_ref,
      "ChildProviderQualificationManifestV1.independent_verification_ref"
    );
    if (manifest.independent_verification_ref.kind !== "child-provider-independent-verification") {
      throw new Error(
        "ChildProviderQualificationManifestV1 verification ref has the wrong exact kind"
      );
    }
  }
  if (manifest.operator_decision_ref !== null) {
    assertArtifactRefIdentity(
      manifest.operator_decision_ref,
      "ChildProviderQualificationManifestV1.operator_decision_ref"
    );
    if (manifest.operator_decision_ref.kind !== "child-provider-operator-decision") {
      throw new Error(
        "ChildProviderQualificationManifestV1 operator decision has the wrong exact kind"
      );
    }
  }
  const hasEvidence = manifest.evidence_refs.length > 0;
  const hasVerification = manifest.independent_verification_ref !== null;
  const hasOperatorDecision = manifest.operator_decision_ref !== null;
  if (
    manifest.status === "candidate" &&
    (hasEvidence || hasVerification || hasOperatorDecision || manifest.state_reason !== null)
  ) {
    throw new Error("ChildProviderQualificationManifestV1 candidate cannot claim evidence");
  }
  if (
    manifest.status === "qualification_running" &&
    (hasVerification || hasOperatorDecision || manifest.state_reason !== null)
  ) {
    throw new Error(
      "ChildProviderQualificationManifestV1 running qualification cannot claim a decision"
    );
  }
  if (
    manifest.status === "qualified_non_discoverable" &&
    (!hasEvidence || !hasVerification || hasOperatorDecision || manifest.state_reason !== null)
  ) {
    throw new Error(
      "ChildProviderQualificationManifestV1 qualified state requires evidence and independent verification only"
    );
  }
  if (
    manifest.status === "discoverable" &&
    (!hasEvidence || !hasVerification || !hasOperatorDecision || manifest.state_reason !== null)
  ) {
    throw new Error(
      "ChildProviderQualificationManifestV1 discoverable state requires evidence, verification, and operator decision"
    );
  }
  if (manifest.status === "stale") {
    if (!hasEvidence || !hasVerification || manifest.state_reason === null) {
      throw new Error(
        "ChildProviderQualificationManifestV1 stale state retains evidence and explains staleness"
      );
    }
  }
  if (manifest.status === "withdrawn") {
    if (
      !hasEvidence ||
      !hasVerification ||
      !hasOperatorDecision ||
      manifest.state_reason === null
    ) {
      throw new Error(
        "ChildProviderQualificationManifestV1 withdrawn state retains evidence and operator decision"
      );
    }
  }
  if (manifest.state_reason !== null) {
    assertText(manifest.state_reason, "ChildProviderQualificationManifestV1.state_reason", {
      minBytes: 1,
      maxBytes: 4_096,
      multiline: true,
    });
  }
  assertRfc3339Utc(manifest.recorded_at, "ChildProviderQualificationManifestV1.recorded_at");
  assertCanonicalBytesAtMost(
    manifest,
    "ChildProviderQualificationManifestV1",
    MAX_QUALIFICATION_MANIFEST_BYTES
  );
  return manifest;
}

/**
 * Durable next-family call record. A separate validator keeps current storage/dispatch behavior
 * closed until the later migration/runtime tasks explicitly admit this schema.
 */
export const ChildWorkflowCallRecordV3Schema = Type.Object(
  {
    schema_version: Type.Literal(3),
    call_id: OpaqueIdSchema,
    parent_identity: RunIdentitySchema,
    parent_registration_sha256: Sha256Schema,
    parent_state_id: OpaqueIdSchema,
    parent_state_visit: Type.Integer({ minimum: 1 }),
    call_offset: Type.Integer({ minimum: 0 }),
    call_key: OpaqueIdSchema,
    child_identity: RunIdentitySchema,
    child_registration_sha256: Sha256Schema,
    child_name: OpaqueIdSchema,
    idempotency_key_digest: Sha256Schema,
    lifecycle: ChildWorkflowLifecycleV1Schema,
    directive: InvokeChildWorkflowDirectiveV4Schema,
    lease_state: ChildWorkflowProgressLeaseStateV1Schema,
    settlement: ChildResourceSettlementV1Schema,
    pending_gate: Type.Union([PendingChildGateV1Schema, Type.Null()]),
    terminal_result_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    accepted_result: Type.Union([AcceptedChildResultV1Schema, Type.Null()]),
    created_at: Rfc3339UtcSchema,
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ChildWorkflowCallRecordV3 = Readonly<Static<typeof ChildWorkflowCallRecordV3Schema>>;

export function validateChildWorkflowCallRecordV3(value: unknown): ChildWorkflowCallRecordV3 {
  const record = validateSkillSchema(
    ChildWorkflowCallRecordV3Schema,
    value,
    "ChildWorkflowCallRecordV3"
  );
  const directive = validateInvokeChildWorkflowDirectiveV4(record.directive);
  const leaseState = validateChildWorkflowProgressLeaseState(record.lease_state);
  const settlement = validateChildResourceSettlementAgainstReservation({
    settlement: record.settlement,
    reservation: directive.reservation,
  });
  const expectedCallId = childWorkflowCallId({
    parent_run_id: record.parent_identity.run_id,
    parent_state_id: record.parent_state_id,
    call_key: record.call_key,
  });
  if (record.call_id !== expectedCallId) {
    throw new Error("ChildWorkflowCallRecordV3 call_id does not match canonical identity");
  }
  const expectedChildIdentity = childWorkflowRunIdentity({
    call_id: record.call_id,
    parent: record.parent_identity,
    child_name: record.child_name,
  });
  if (!sameCanonical(record.child_identity, expectedChildIdentity)) {
    throw new Error("ChildWorkflowCallRecordV3 child identity is not derived canonically");
  }
  if (
    !sameCanonical(directive.identity, record.parent_identity) ||
    directive.state_id !== record.parent_state_id ||
    directive.parent_state_visit !== record.parent_state_visit ||
    directive.call_offset !== record.call_offset ||
    directive.call_key !== record.call_key ||
    directive.child_name !== record.child_name ||
    directive.parent_registration_sha256 !== record.parent_registration_sha256 ||
    directive.child_registration_sha256 !== record.child_registration_sha256
  ) {
    throw new Error("ChildWorkflowCallRecordV3 directive identity mismatch");
  }
  if (record.idempotency_key_digest !== sha256(canonicalJson(directive))) {
    throw new Error("ChildWorkflowCallRecordV3 idempotency digest mismatch");
  }
  if (!sameCanonical(leaseState.binding, directive.progress_lease)) {
    throw new Error("ChildWorkflowCallRecordV3 lease binding mismatch");
  }
  if (leaseState.fence.execution_attempt_id !== directive.reservation.attempt_id) {
    throw new Error("ChildWorkflowCallRecordV3 execution attempt lost its reservation fence");
  }
  const gate = record.pending_gate === null ? null : validatePendingChildGate(record.pending_gate);
  if (record.lifecycle === "waiting_user") {
    if (gate === null || gate.state !== "pending") {
      throw new Error("ChildWorkflowCallRecordV3 waiting_user requires a pending gate");
    }
  } else if (gate !== null && gate.state === "pending") {
    throw new Error("ChildWorkflowCallRecordV3 pending gate requires waiting_user lifecycle");
  }
  if (gate !== null) {
    if (
      gate.call_id !== record.call_id ||
      gate.child_run_id !== record.child_identity.run_id ||
      !sameCanonical(gate.fence, leaseState.fence)
    ) {
      throw new Error("ChildWorkflowCallRecordV3 pending gate identity or fence mismatch");
    }
  }
  if (record.terminal_result_ref !== null) {
    assertArtifactRefIdentity(
      record.terminal_result_ref,
      "ChildWorkflowCallRecordV3.terminal_result_ref"
    );
    if (
      record.terminal_result_ref.kind !== "child-result" ||
      record.terminal_result_ref.content_schema?.schema_id !== "penny.child-workflow-result.v1" ||
      record.terminal_result_ref.content_schema.schema_version !== 1
    ) {
      throw new Error("ChildWorkflowCallRecordV3 terminal result has the wrong exact contract");
    }
  }
  const acceptance =
    record.accepted_result === null ? null : validateAcceptedChildResult(record.accepted_result);
  if (acceptance !== null) {
    if (
      acceptance.call_id !== record.call_id ||
      acceptance.parent_run_id !== record.parent_identity.run_id ||
      acceptance.parent_state_id !== record.parent_state_id ||
      acceptance.child_run_id !== record.child_identity.run_id ||
      !sameCanonical(acceptance.fence, leaseState.fence) ||
      !sameCanonical(acceptance.child_result_ref, record.terminal_result_ref) ||
      acceptance.settlement_id !== settlement.settlement_id
    ) {
      throw new Error("ChildWorkflowCallRecordV3 accepted result identity mismatch");
    }
    if (acceptance.semantic_output_ref !== null) {
      assertOutputArtifactMatchesContract(
        acceptance.semantic_output_ref,
        directive.expected_output,
        "ChildWorkflowCallRecordV3.accepted_result.semantic_output_ref"
      );
    }
  }
  const activeLifecycle =
    record.lifecycle === "reserved" ||
    record.lifecycle === "running" ||
    record.lifecycle === "paused" ||
    record.lifecycle === "waiting_user";
  if (activeLifecycle && (record.terminal_result_ref !== null || acceptance !== null)) {
    throw new Error("ChildWorkflowCallRecordV3 active lifecycle cannot retain a terminal result");
  }
  if (
    (record.lifecycle === "reserved" || record.lifecycle === "running") &&
    leaseState.state !== "active"
  ) {
    throw new Error("ChildWorkflowCallRecordV3 running lifecycle requires an active lease");
  }
  if (
    (record.lifecycle === "paused" || record.lifecycle === "waiting_user") &&
    leaseState.state !== "suspended"
  ) {
    throw new Error("ChildWorkflowCallRecordV3 paused lifecycle requires a suspended lease");
  }
  if (record.lifecycle === "terminal_recorded") {
    if (record.terminal_result_ref === null || acceptance !== null || settlement.state !== "open") {
      throw new Error(
        "ChildWorkflowCallRecordV3 terminal_recorded requires an unaccepted result and open settlement"
      );
    }
    if (leaseState.state !== "closed") {
      throw new Error("ChildWorkflowCallRecordV3 terminal_recorded requires a closed lease");
    }
  }
  if (record.lifecycle === "consumed") {
    if (
      record.terminal_result_ref === null ||
      acceptance?.disposition !== "accepted" ||
      settlement.state !== "settled"
    ) {
      throw new Error(
        "ChildWorkflowCallRecordV3 consumed requires accepted result and settled reservation"
      );
    }
    if (leaseState.state !== "closed") {
      throw new Error("ChildWorkflowCallRecordV3 consumed requires a closed lease");
    }
  }
  if (record.lifecycle === "failed" || record.lifecycle === "cancelled") {
    if (acceptance?.disposition === "accepted") {
      throw new Error("ChildWorkflowCallRecordV3 failed/cancelled result cannot be accepted");
    }
    if (
      settlement.state !== "settled" ||
      (leaseState.state !== "closed" && leaseState.state !== "expired")
    ) {
      throw new Error(
        "ChildWorkflowCallRecordV3 failed/cancelled lifecycle must be settled and fenced closed"
      );
    }
  }
  if (activeLifecycle && settlement.state !== "open") {
    throw new Error("ChildWorkflowCallRecordV3 active lifecycle requires open settlement");
  }
  if (record.created_at > record.updated_at) {
    throw new Error("ChildWorkflowCallRecordV3 updated_at precedes created_at");
  }
  assertRfc3339Utc(record.created_at, "ChildWorkflowCallRecordV3.created_at");
  assertRfc3339Utc(record.updated_at, "ChildWorkflowCallRecordV3.updated_at");
  assertCanonicalBytesAtMost(record, "ChildWorkflowCallRecordV3", MAX_CHILD_CALL_V3_BYTES);
  return record;
}
