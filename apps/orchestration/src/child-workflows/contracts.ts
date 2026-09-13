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
