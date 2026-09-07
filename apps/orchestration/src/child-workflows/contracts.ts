import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../checkpointer.js";
import {
  ArtifactRefSchema,
  ChildWorkflowBudgetAllocationV1Schema,
  ChildWorkflowOutputContractV1Schema,
  ChildWorkflowPolicyBindingV1Schema,
  JsonValueSchema,
  RunIdentitySchema,
  type ArtifactRef,
  type ChildWorkflowBudgetAllocationV1,
  type ChildWorkflowOutputContractV1,
  type ChildWorkflowPolicyBindingV1,
  type InvokeChildWorkflowDirective,
  type RunIdentity,
} from "../contracts.js";
import {
  OpaqueIdSchema,
  Sha256Schema,
  TextSchema,
  assertOpaqueId,
  assertText,
  assertUnique,
  validateSkillSchema,
} from "../skill-contracts/common.js";

const MAX_CONTEXT_ENTRIES = 64;
const MAX_CONTEXT_REFS = 64;
const MAX_CONTEXT_LIMITATIONS = 32;
const MAX_CONTEXT_BYTES = 1_048_576;

export const ChildWorkflowRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.child-workflow-request.v1"),
    schema_version: Type.Literal(1),
    child_name: OpaqueIdSchema,
    goal: TextSchema({ minBytes: 1, maxBytes: 32_768, multiline: true }),
    constraints: Type.Record(Type.String(), JsonValueSchema),
    policy_binding: ChildWorkflowPolicyBindingV1Schema,
  },
  { additionalProperties: false }
);
export type ChildWorkflowRequestV1 = Readonly<Static<typeof ChildWorkflowRequestV1Schema>>;

export function validateChildWorkflowRequest(value: unknown): ChildWorkflowRequestV1 {
  const request = validateSkillSchema(
    ChildWorkflowRequestV1Schema,
    value,
    "ChildWorkflowRequestV1"
  );
  assertOpaqueId(request.child_name, "ChildWorkflowRequestV1.child_name");
  assertText(request.goal, "ChildWorkflowRequestV1.goal", {
    minBytes: 1,
    maxBytes: 32_768,
    multiline: true,
    trimmedNonEmpty: true,
  });
  for (const [label, value] of [
    ["project_id", request.policy_binding.project_id],
    ["principal_id", request.policy_binding.principal_id],
    ["scope_id", request.policy_binding.scope_id],
    ["source_policy_id", request.policy_binding.source_policy_id],
    ["destination_policy_id", request.policy_binding.destination_policy_id],
  ] as const) {
    assertOpaqueId(value, `ChildWorkflowRequestV1.policy_binding.${label}`);
  }
  return request;
}

export function validateCanonicalChildWorkflowRequestBytes(
  bytes: Uint8Array,
  ref: ArtifactRef
): ChildWorkflowRequestV1 {
  const body = Buffer.from(bytes);
  if (
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
      end: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
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
    limitations: Type.Array(
      TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
      { maxItems: MAX_CONTEXT_LIMITATIONS, uniqueItems: true }
    ),
  },
  { additionalProperties: false }
);
export type EvidenceContextV1 = Readonly<Static<typeof EvidenceContextV1Schema>>;

export function validateEvidenceContext(value: unknown): EvidenceContextV1 {
  const context = validateSkillSchema(EvidenceContextV1Schema, value, "EvidenceContextV1");
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
      entry.selector.end < entry.selector.start
    ) {
      throw new Error(`EvidenceContextV1 entry '${entry.entry_id}' has an inverted selector`);
    }
    const exact = refs.get(entry.source_ref.artifact_id);
    if (exact === undefined || canonicalJson(exact) !== canonicalJson(entry.source_ref)) {
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

export const ChildWorkflowTargetPolicyV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    child_name: OpaqueIdSchema,
    child_request_schema_id: Type.String({ minLength: 1, maxLength: 128 }),
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

export const ChildWorkflowPolicyV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    max_nesting_depth: Type.Literal(1),
    max_active_children: Type.Literal(1),
    max_calls: Type.Integer({ minimum: 1, maximum: 64 }),
    project_concurrency_limit: Type.Integer({ minimum: 1, maximum: 64 }),
    total_budget: ChildWorkflowBudgetAllocationV1Schema,
    parent_sealing_reserve: ChildWorkflowBudgetAllocationV1Schema,
    targets: Type.Array(ChildWorkflowTargetPolicyV1Schema, {
      minItems: 1,
      maxItems: 16,
    }),
  },
  { additionalProperties: false }
);
export type ChildWorkflowPolicyV1 = Readonly<Static<typeof ChildWorkflowPolicyV1Schema>>;

function budgetAtMost(
  child: ChildWorkflowBudgetAllocationV1,
  parent: ChildWorkflowBudgetAllocationV1
): boolean {
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
  for (const target of policy.targets) {
    for (const id of [
      target.child_name,
      target.scope_id,
      target.source_policy_id,
      target.destination_policy_id,
    ]) {
      assertOpaqueId(id, "ChildWorkflowPolicyV1 target identity");
    }
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
    terminal_sha256: Sha256Schema,
    met: Type.Boolean(),
    output_artifact: Type.Union([ArtifactRefSchema, Type.Null()]),
    artifacts: Type.Array(ArtifactRefSchema, { maxItems: 128 }),
    usage: ChildWorkflowUsageV1Schema,
  },
  { additionalProperties: false }
);
export type ChildWorkflowResultV1 = Readonly<Static<typeof ChildWorkflowResultV1Schema>>;

export function validateChildWorkflowResult(value: unknown): ChildWorkflowResultV1 {
  const result = validateSkillSchema(ChildWorkflowResultV1Schema, value, "ChildWorkflowResultV1");
  const expectedMet = result.terminal_action === "complete";
  if (result.met !== expectedMet) {
    throw new Error("ChildWorkflowResultV1 terminal action and met truth disagree");
  }
  if (result.child_identity.run_id === result.parent_run_id) {
    throw new Error("ChildWorkflowResultV1 parent and child identities must differ");
  }
  if (result.met && result.output_artifact === null) {
    throw new Error("positive ChildWorkflowResultV1 requires its exact output artifact");
  }
  if (
    result.output_artifact !== null &&
    !result.artifacts.some(
      (artifact) => canonicalJson(artifact) === canonicalJson(result.output_artifact)
    )
  ) {
    throw new Error("ChildWorkflowResultV1 output is absent from the terminal artifact set");
  }
  return result;
}

export type ChildWorkflowLifecycleV1 =
  | "reserved"
  | "running"
  | "waiting_user"
  | "paused"
  | "terminal_recorded"
  | "consumed"
  | "failed"
  | "cancelled";

export interface ChildWorkflowCallRecordV1 {
  readonly schema_version: 1;
  readonly call_id: string;
  readonly parent_run_id: string;
  readonly parent_state_id: string;
  readonly parent_visit_sequence: number;
  readonly parent_visit_offset: number;
  readonly call_key: string;
  readonly child_run_id: string;
  readonly child_name: string;
  readonly directive_sha256: string;
  readonly directive: InvokeChildWorkflowDirective;
  readonly request_ref_sha256: string;
  readonly input_refs_sha256: string;
  readonly expected_output_sha256: string;
  readonly parent_registration_sha256: string;
  readonly child_registration_sha256: string;
  readonly policy_sha256: string;
  readonly budget: ChildWorkflowBudgetAllocationV1;
  readonly lifecycle: ChildWorkflowLifecycleV1;
  readonly terminal_sha256?: string;
  readonly output_artifact_id?: string;
  readonly output_artifact_sha256?: string;
  readonly usage?: ChildWorkflowUsageV1;
  readonly created_at: string;
  readonly updated_at: string;
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

export function childWorkflowDirectiveSha256(directive: InvokeChildWorkflowDirective): string {
  return sha256(canonicalJson(directive));
}

export function childWorkflowPolicyBindingEquals(
  left: ChildWorkflowPolicyBindingV1,
  right: ChildWorkflowPolicyBindingV1
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function childWorkflowOutputContractEquals(
  left: ChildWorkflowOutputContractV1,
  right: ChildWorkflowOutputContractV1
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function childBudgetFits(
  allocation: ChildWorkflowBudgetAllocationV1,
  available: ChildWorkflowBudgetAllocationV1
): boolean {
  return budgetAtMost(allocation, available);
}
