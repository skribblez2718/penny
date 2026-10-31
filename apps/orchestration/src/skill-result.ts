/** Current skill-tool result contract. Historical artifact/history readers are independent. */
import { isDeepStrictEqual } from "node:util";

import { Type, type Static } from "typebox";

import {
  ArtifactDispatchPauseV1Schema,
  ArtifactDispatchRecoveryV1Schema,
  ArtifactRefSchema,
  JsonValueSchema,
  RunIdentitySchema,
  TerminalDirectiveSchema,
  parseArtifactDispatchPause,
  validateContract,
} from "./contracts.js";
import { currentArtifactRef } from "./artifact-store.js";
import {
  SealDiagnosticsProjectionV1Schema,
  validateSealDiagnosticsProjection,
} from "./skill-contracts/sealing.js";

const MAX_TEXT_LENGTH = 32_768;
const MAX_COLLECTION_ITEMS = 128;
export const MAX_SKILL_RESULT_NODES = 128;
export const MAX_SKILL_RESULT_DEPTH = 4;
/** Representation capacity (128 bounded text blocks), not a workflow/call/repair allowance. */
export const MAX_SKILL_RESULT_BYTES = MAX_SKILL_RESULT_NODES * MAX_TEXT_LENGTH;
/** Applies to domain JSON too, before any recursive schema validator is entered. */
export const MAX_SKILL_RESULT_JSON_DEPTH = 32;

const Text = Type.String({ maxLength: MAX_TEXT_LENGTH });
const NonEmptyText = Type.String({ minLength: 1, maxLength: MAX_TEXT_LENGTH });
const Counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const JsonRecord = Type.Record(Type.String(), JsonValueSchema);

export const SkillClarificationContinuationSchema = Type.Object(
  {
    kind: Type.Literal("clarification"),
    identity: RunIdentitySchema,
    gate_id: NonEmptyText,
    challenge: NonEmptyText,
    // Display/retry data only. The engine still verifies the existing run, admission and gate.
    resume_invocation: Type.Optional(
      Type.Object(
        {
          skill_name: NonEmptyText,
          session_id: NonEmptyText,
          goal: NonEmptyText,
          constraints: JsonRecord,
          input_artifacts: Type.Optional(
            Type.Array(Type.String({ pattern: "^art_[a-f0-9]{64}$" }), {
              maxItems: MAX_COLLECTION_ITEMS,
            })
          ),
          context_artifacts: Type.Optional(
            Type.Array(Type.String({ pattern: "^art_[a-f0-9]{64}$" }), {
              maxItems: MAX_COLLECTION_ITEMS,
            })
          ),
          model: Type.Optional(NonEmptyText),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);

const QuestionSchema = Type.Object(
  {
    id: NonEmptyText,
    label: Text,
    prompt: NonEmptyText,
    options: Type.Optional(
      Type.Array(
        Type.Object(
          { value: Text, label: Text, description: Type.Optional(Text) },
          { additionalProperties: false }
        ),
        { maxItems: MAX_COLLECTION_ITEMS }
      )
    ),
    allowOther: Type.Optional(Type.Boolean()),
    type: Type.Optional(Type.Union([Type.Literal("single"), Type.Literal("multi")])),
  },
  { additionalProperties: false }
);

export const SkillRepairDiagnosticsSchema = Type.Object(
  {
    origin_state: Text,
    feedback_kind: Text,
    budget: Type.Object(
      { used: Counter, limit: Type.Union([Counter, Type.Null()]) },
      { additionalProperties: false }
    ),
    feedback_report_refs: Type.Array(ArtifactRefSchema, { maxItems: MAX_COLLECTION_ITEMS }),
  },
  { additionalProperties: false }
);

/**
 * The sole current outer field inventory, including recursively closed aggregate children.
 * `result` is the engine-owned domain JSON map, not a second terminal-field inventory.
 * `plan` is a display-only JSON map retained for resumed chain previews. Neither is a
 * source of arbitrary continuation IDs. The parser below bounds all JSON before validation.
 */
export const SkillResultSchema = Type.Cyclic(
  {
    SkillResult: Type.Object(
      {
        success: Type.Boolean(),
        session_id: Text,
        skill_name: NonEmptyText,
        state: NonEmptyText,
        plan: Type.Optional(JsonRecord),
        plan_steps: Type.Optional(Type.Array(JsonRecord, { maxItems: MAX_COLLECTION_ITEMS })),
        requires_approval: Type.Boolean(),
        session_room: Type.Optional(Text),
        steps_total: Counter,
        // Invocation history is not a fan-out list. Count/repair policy belongs to the
        // engine; these lists (including concatenated aggregates) use the byte ceiling.
        agents_invoked: Type.Array(NonEmptyText),
        errors: Type.Array(Text),
        refusal_code: Type.Optional(
          Type.Union([
            Type.Literal("SKILL_NOT_REGISTERED"),
            Type.Literal("SKILL_ENTRYPOINT_MISMATCH"),
            Type.Literal("SKILL_PACKAGE_INVALID"),
          ])
        ),
        state_failure: Type.Optional(
          Type.Object(
            {
              code: NonEmptyText,
              details: Type.Object(
                {
                  component: NonEmptyText,
                  actualSchemaVersion: Type.Optional(Counter),
                  requiredSchemaVersion: Type.Optional(Counter),
                  upgradeSupported: Type.Optional(Type.Boolean()),
                  recoveryAction: Type.Optional(Text),
                },
                { additionalProperties: false }
              ),
            },
            { additionalProperties: false }
          )
        ),
        input_assurance: Type.Optional(
          Type.Object(
            {
              mode: Type.Union([
                Type.Literal("reviewed_definition"),
                Type.Literal("semantic_only"),
                Type.Literal("not_applicable"),
              ]),
              specification_artifact_id: Type.Union([
                Type.String({ pattern: "^art_[a-f0-9]{64}$" }),
                Type.Null(),
              ]),
              assurance_ref: ArtifactRefSchema,
            },
            { additionalProperties: false }
          )
        ),
        result: Type.Optional(TerminalDirectiveSchema.properties.result),
        output_artifact_ref: Type.Optional(ArtifactRefSchema),
        best_partial_artifact_refs: Type.Optional(
          Type.Array(ArtifactRefSchema, { maxItems: MAX_COLLECTION_ITEMS })
        ),
        repair_diagnostics: Type.Optional(SkillRepairDiagnosticsSchema),
        seal_diagnostics: Type.Optional(SealDiagnosticsProjectionV1Schema),
        retriable: Type.Optional(Type.Boolean()),
        dispatch_pause: Type.Optional(ArtifactDispatchPauseV1Schema),
        recovery: Type.Optional(ArtifactDispatchRecoveryV1Schema),
        continuation: Type.Optional(SkillClarificationContinuationSchema),
        mode: Type.Optional(
          Type.Union([Type.Literal("single"), Type.Literal("parallel"), Type.Literal("chain")])
        ),
        chain_step: Type.Optional(Counter),
        chain_total: Type.Optional(Counter),
        chain_session_id: Type.Optional(Text),
        chain_error_step: Type.Optional(Counter),
        chain_results: Type.Optional(
          Type.Array(Type.Ref("SkillResult"), { maxItems: MAX_COLLECTION_ITEMS })
        ),
        resumable: Type.Optional(Type.Boolean()),
        parallel_results: Type.Optional(
          Type.Array(Type.Ref("SkillResult"), { maxItems: MAX_COLLECTION_ITEMS })
        ),
        escalation: Type.Optional(
          Type.Object(
            {
              trustedTransportCapability: Type.Optional(NonEmptyText),
              questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 32 }),
              unknown_reason: Type.Optional(Text),
              previous_state: Type.Optional(Text),
            },
            { additionalProperties: false }
          )
        ),
      },
      { additionalProperties: false }
    ),
  },
  "SkillResult"
);
export type SkillResult = Static<typeof SkillResultSchema>;

function invalid(): never {
  // Never interpolate rejected data (which can include private diagnostic bodies).
  throw new TypeError("invalid current skill result");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bounded, iterative JSON preflight: no toJSON/accessor execution or recursive stringify. */
function assertBoundedRepresentation(root: unknown): void {
  const active = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number; leave?: boolean }> = [
    { value: root, depth: 0 },
  ];
  let bytes = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    const { value, depth } = item;
    if (item.leave) {
      if (typeof value === "object" && value !== null) active.delete(value);
      continue;
    }
    if (depth > MAX_SKILL_RESULT_JSON_DEPTH) invalid();
    if (typeof value === "string") {
      if (value.length > MAX_SKILL_RESULT_BYTES) invalid();
      bytes += Buffer.byteLength(JSON.stringify(value), "utf8");
    } else if (value === null || typeof value === "boolean") {
      bytes += value === null ? 4 : value ? 4 : 5;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) invalid();
      bytes += String(value).length;
    } else if (typeof value === "object") {
      if (active.has(value)) invalid();
      const prototype: unknown = Object.getPrototypeOf(value);
      if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) invalid();
      active.add(value);
      stack.push({ value, depth, leave: true });
      const keys = Object.keys(value);
      // Charge delimiters before allocating the traversal queue; even empty values cost bytes.
      bytes += 2;
      if (keys.length > MAX_SKILL_RESULT_BYTES / 2) invalid();
      if (bytes > MAX_SKILL_RESULT_BYTES) invalid();
      if (Array.isArray(value) && keys.length !== value.length) invalid();
      let entries = 0;
      for (const key of keys) {
        if (Array.isArray(value) && key !== String(entries)) invalid();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor)) invalid();
        const child: unknown = descriptor.value;
        if (child === undefined && !Array.isArray(value)) continue; // Optional producer fields.
        if (entries++ > 0) bytes += 1;
        if (!Array.isArray(value)) {
          if (key.length > MAX_SKILL_RESULT_BYTES) invalid();
          bytes += Buffer.byteLength(JSON.stringify(key), "utf8") + 1;
        }
        if (bytes > MAX_SKILL_RESULT_BYTES) invalid();
        stack.push({ value: child, depth: depth + 1 });
      }
    } else invalid();
    if (bytes > MAX_SKILL_RESULT_BYTES) invalid();
  }
}

/** Check the aggregate graph before entering TypeBox's recursive validator. */
function assertBoundedResultTree(root: unknown): void {
  const queue = [{ value: root, depth: 0 }];
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index];
    if (item === undefined) invalid();
    const { value, depth } = item;
    if (!isRecord(value) || depth > MAX_SKILL_RESULT_DEPTH) invalid();
    for (const key of ["chain_results", "parallel_results"] as const) {
      const children = value[key];
      if (children === undefined) continue;
      if (!Array.isArray(children)) invalid();
      if (queue.length + children.length > MAX_SKILL_RESULT_NODES) invalid();
      for (const child of children) queue.push({ value: child, depth: depth + 1 });
    }
  }
}

/** Prevalidated tree traversal; no discovery, arbitrary object walk, or silent truncation. */
export function skillResultNodes(root: SkillResult): SkillResult[] {
  assertBoundedResultTree(root);
  const nodes = [root];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node === undefined) invalid();
    nodes.push(...(node.parallel_results ?? []), ...(node.chain_results ?? []));
  }
  return nodes;
}

function canonicalAddress(part: string): boolean {
  return (
    part.length > 0 &&
    part === part.trim() &&
    !Array.from(part).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  );
}

function assertCurrentSemantics(node: SkillResult): void {
  if (node.state_failure !== undefined && node.success) invalid();
  for (const ref of [node.output_artifact_ref, ...(node.best_partial_artifact_refs ?? [])]) {
    if (ref !== undefined) currentArtifactRef(ref);
  }
  if (node.input_assurance !== undefined) {
    const assurance = node.input_assurance;
    currentArtifactRef(assurance.assurance_ref);
    if (
      assurance.assurance_ref.kind !== "composition-assurance" ||
      (assurance.mode === "not_applicable") !== (assurance.specification_artifact_id === null)
    )
      invalid();
  }
  if (node.repair_diagnostics !== undefined) {
    if (node.success) invalid();
    for (const ref of node.repair_diagnostics.feedback_report_refs) currentArtifactRef(ref);
  }
  if (node.seal_diagnostics !== undefined) {
    if (node.success) invalid();
    validateSealDiagnosticsProjection(node.seal_diagnostics);
  }
  if (node.result !== undefined) {
    if (typeof node.result.met !== "boolean") invalid();
    if (node.result.schema_version !== undefined && node.result.schema_version !== 1) invalid();
    if (node.result.output_artifact_ref != null)
      currentArtifactRef(node.result.output_artifact_ref);
    if (node.result.best_partial_artifact_refs !== undefined) {
      const refs = node.result.best_partial_artifact_refs;
      if (!Array.isArray(refs) || refs.length > MAX_COLLECTION_ITEMS) invalid();
      for (const ref of refs) currentArtifactRef(ref);
    }
  }
  if (node.dispatch_pause !== undefined) {
    if (node.success) invalid();
    parseArtifactDispatchPause(node.dispatch_pause);
    if (node.retriable !== undefined && node.retriable !== node.dispatch_pause.retryable) invalid();
    if (
      node.recovery !== undefined &&
      !isDeepStrictEqual(node.recovery, node.dispatch_pause.recovery)
    )
      invalid();
  } else if (node.recovery !== undefined) invalid();
  if ((node.escalation === undefined) !== (node.continuation === undefined)) invalid();
  if (node.continuation !== undefined) {
    if (node.success || node.result !== undefined || node.dispatch_pause !== undefined) invalid();
    const identity = node.continuation.identity;
    if (Object.values(identity).some((part) => typeof part === "string" && !canonicalAddress(part)))
      invalid();
    const resume = node.continuation.resume_invocation;
    if (
      resume !== undefined &&
      (resume.session_id !== identity.session_id ||
        resume.skill_name !== identity.playbook ||
        Object.hasOwn(resume.constraints, "user_response"))
    )
      invalid();
    if (
      node.requires_approval ||
      node.errors.length > 0 ||
      node.mode === "parallel" ||
      node.parallel_results !== undefined ||
      identity.playbook === "chain" ||
      identity.playbook === "parallel" ||
      (node.skill_name !== "chain" &&
        (node.chain_session_id !== undefined ||
          node.chain_error_step !== undefined ||
          node.chain_results !== undefined ||
          node.parallel_results !== undefined ||
          node.resumable !== undefined))
    )
      invalid();
    // A chain wrapper retains the *paused step's* identity, never the chain session as a run.
    // Run IDs and session IDs are independent; no inferred run/session equivalence grants authority.
    if (node.skill_name === "chain") {
      const step = node.chain_error_step;
      const total = node.chain_total;
      if (
        node.mode !== "chain" ||
        node.state !== "awaiting_clarification" ||
        node.chain_session_id === undefined ||
        !canonicalAddress(node.chain_session_id) ||
        node.session_id !== node.chain_session_id ||
        node.resumable !== true ||
        total === undefined ||
        total < 1 ||
        node.steps_total !== total ||
        step === undefined ||
        step >= total ||
        node.chain_step !== step ||
        identity.session_id === node.chain_session_id ||
        identity.run_id === node.chain_session_id
      )
        invalid();
      // Current producers omit the paused child: the available children are precisely the
      // successful zero-based prefix (including the empty prefix on a first-step wait).
      if (node.chain_results === undefined || node.chain_results.length !== step) invalid();
      const sessions = new Set<string>();
      for (const [index, child] of node.chain_results.entries()) {
        if (
          !child.success ||
          (child.result !== undefined && child.result.met !== true) ||
          child.continuation !== undefined ||
          child.dispatch_pause !== undefined ||
          child.session_id === identity.session_id ||
          child.session_id === node.chain_session_id ||
          sessions.has(child.session_id) ||
          (child.chain_step !== undefined && child.chain_step !== index) ||
          (child.chain_total !== undefined && child.chain_total !== total) ||
          (child.chain_session_id !== undefined && child.chain_session_id !== node.chain_session_id)
        )
          invalid();
        sessions.add(child.session_id);
      }
    } else if (identity.session_id !== node.session_id || identity.playbook !== node.skill_name) {
      invalid();
    }
  }
}

/** Validate current results only. No historical fallback and no field stripping/coercion. */
export function parseCurrentSkillResult(value: unknown): SkillResult {
  assertBoundedRepresentation(value);
  assertBoundedResultTree(value);
  const result = validateContract(SkillResultSchema, value, "current skill result");
  for (const node of skillResultNodes(result)) assertCurrentSemantics(node);
  return result;
}
