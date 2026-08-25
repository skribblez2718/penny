import path from "node:path";

import { Type, type Static } from "typebox";

import {
  ArtifactRefSchema,
  DirectiveSchema,
  JsonValueSchema,
  RunIdentitySchema,
  RunStatusSchema,
  TrustProfileSchema,
  validateContract,
  validateDirective,
} from "./contracts.js";
import {
  KbArtifactHandleSchema,
  OperationActionSchema,
  PageRevisionRefSchema,
} from "./kb/contracts.js";

const JsonObjectSchema = Type.Record(Type.String(), JsonValueSchema);
export type JsonObject = Static<typeof JsonObjectSchema>;

export const ResearchDataSchema = Type.Object({
  mode: Type.String(),
  max_sub_queries: Type.Integer(),
  max_research_rounds: Type.Integer(),
  critique_passes: Type.Integer(),
  research_round: Type.Integer(),
  report_format: Type.String(),
  sub_queries: Type.Array(Type.String()),
  phase: Type.String(),
  plan_revision: Type.Integer(),
  report_revision: Type.Integer(),
  validation_revision: Type.Integer(),
  plan_revisions: Type.Integer(),
  report_revisions: Type.Integer(),
  validation_revisions: Type.Integer(),
  plan_critique_issues: Type.Array(Type.String()),
  report_critique_issues: Type.Array(Type.String()),
  validation_issues: Type.Array(Type.String()),
  validation_verdict: Type.String(),
  report_written: Type.Boolean(),
  report_dir: Type.String(),
  report_files: Type.Array(Type.String()),
  warnings: Type.Array(Type.String()),
  plan_critique_exhausted: Type.Boolean(),
  report_critique_exhausted: Type.Boolean(),
  validation_exhausted: Type.Boolean(),
  rigor_escalated: Type.Boolean(),
  echo_branches_dispatched: Type.Integer(),
  evidence_needed: Type.Array(Type.String()),
});
export type ResearchData = Static<typeof ResearchDataSchema>;

export const PendingBranchSchema = Type.Object({
  branch_id: Type.String(),
  agent: Type.String(),
  attempt: Type.Integer({ minimum: 1 }),
  completed: Type.Boolean(),
  confidence: Type.Union([
    Type.Literal("CERTAIN"),
    Type.Literal("PROBABLE"),
    Type.Literal("POSSIBLE"),
    Type.Literal("UNCERTAIN"),
    Type.Null(),
  ]),
  result: Type.Union([JsonObjectSchema, Type.Null()]),
  artifact: Type.Union([ArtifactRefSchema, Type.Null()]),
});
export type PendingBranch = Static<typeof PendingBranchSchema>;

export const KbPhaseRecordSchema = Type.Object(
  {
    artifact_kind: Type.String(),
    kb_artifact_id: Type.String(),
    counts: Type.Record(Type.String(), Type.Number()),
    verdict: Type.Optional(Type.String()),
  },
  { additionalProperties: JsonValueSchema }
);
export type KbPhaseRecord = Static<typeof KbPhaseRecordSchema>;

const StringListSchema = Type.Array(Type.String());
const SafeCountsSchema = Type.Record(Type.String(), Type.Number());

/**
 * Named metadata contract for the knowledge-base playbook's durable control state.
 *
 * Known fields are typed and validated. Additional JSON fields remain accepted so
 * the codec preserves the pre-TS-210 forward-compatible playbook-data policy.
 */
export const KnowledgeBasePlaybookDataSchema = Type.Object(
  {
    action: Type.Optional(OperationActionSchema),
    admitted_policy_sha256: Type.Optional(Type.String()),
    answer_artifact_id: Type.Optional(Type.String()),
    answer_handle: Type.Optional(Type.Union([KbArtifactHandleSchema, Type.Null()])),
    base_generation_id: Type.Optional(Type.String()),
    content_review_challenge_id: Type.Optional(Type.String()),
    content_review_packet_jcs: Type.Optional(Type.String()),
    content_review_packet_sha256: Type.Optional(Type.String()),
    gate_id: Type.Optional(Type.String()),
    grounding_verified: Type.Optional(Type.Boolean()),
    kb_id: Type.Optional(Type.String()),
    page_revisions: Type.Optional(Type.Array(PageRevisionRefSchema)),
    phases: Type.Optional(Type.Record(Type.String(), KbPhaseRecordSchema)),
    profile_id: Type.Optional(Type.String()),
    promotion_apply_status: Type.Optional(Type.String()),
    promotion_apply_transaction_id: Type.Optional(Type.String()),
    promotion_challenge_id: Type.Optional(Type.String()),
    promotion_decision_intent_sha256: Type.Optional(Type.String()),
    promotion_packet_sha256: Type.Optional(Type.String()),
    promotion_post_apply_verified: Type.Optional(Type.Boolean()),
    promotion_receipt_id: Type.Optional(Type.String()),
    promotion_receipt_sha256: Type.Optional(Type.String()),
    promotion_target_count: Type.Optional(Type.Number()),
    promotion_verified: Type.Optional(Type.Boolean()),
    publication_transaction_id: Type.Optional(Type.String()),
    public_status: Type.Optional(Type.String()),
    published_counts: Type.Optional(SafeCountsSchema),
    published_generation_id: Type.Optional(Type.String()),
    query_counts: Type.Optional(SafeCountsSchema),
    query_page_ids: Type.Optional(StringListSchema),
    query_run_id: Type.Optional(Type.String()),
    review_artifact_ids: Type.Optional(StringListSchema),
    review_decision: Type.Optional(Type.String()),
    review_receipt_id: Type.Optional(Type.String()),
    review_receipt_sha256: Type.Optional(Type.String()),
    save_transaction_id: Type.Optional(Type.String()),
    selected_generation_id: Type.Optional(Type.String()),
    source_capability_ids: Type.Optional(StringListSchema),
    source_ids: Type.Optional(StringListSchema),
    target_capability_ids: Type.Optional(StringListSchema),
    unresolved: Type.Optional(StringListSchema),
    verification_artifact_id: Type.Optional(Type.String()),
    warnings: Type.Optional(StringListSchema),
  },
  { additionalProperties: JsonValueSchema }
);
export type KnowledgeBasePlaybookData = Static<typeof KnowledgeBasePlaybookDataSchema>;

export interface ResearchPlaybookState {
  readonly kind: "research";
  readonly data: JsonObject;
}

export interface KnowledgeBasePlaybookState {
  readonly kind: "knowledge-base";
  readonly data: KnowledgeBasePlaybookData;
}

export interface UnsupportedPlaybookState {
  readonly kind: "unsupported";
  readonly playbook: string;
  readonly data: JsonObject;
}

/** Internal discriminated state. The wire discriminator remains identity.playbook. */
export type PlaybookDurableState =
  | ResearchPlaybookState
  | KnowledgeBasePlaybookState
  | UnsupportedPlaybookState;

export const RunContextSnapshotSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    identity: RunIdentitySchema,
    goal: Type.String(),
    constraints: JsonObjectSchema,
    project_root: Type.String(),
    trust_profile: TrustProfileSchema,
    status: RunStatusSchema,
    state_id: Type.String(),
    previous_state: Type.Union([Type.String(), Type.Null()]),
    step_count: Type.Integer({ minimum: 0 }),
    max_steps: Type.Integer({ minimum: 1 }),
    iteration: Type.Integer({ minimum: 0 }),
    max_iterations: Type.Integer({ minimum: 1 }),
    iteration_history: Type.Array(Type.Array(Type.String())),
    clarification_text: Type.String(),
    met: Type.Boolean(),
    research: ResearchDataSchema,
    playbook_data: Type.Optional(JsonObjectSchema),
    selected_artifacts: Type.Array(ArtifactRefSchema),
    pending_directive: Type.Union([DirectiveSchema, Type.Null()]),
    pending_branches: Type.Array(PendingBranchSchema),
    terminal_directive: Type.Union([DirectiveSchema, Type.Null()]),
  },
  { additionalProperties: false }
);
export type RunContextSnapshot = Static<typeof RunContextSnapshotSchema>;

export type DecodedRunContextState = Omit<RunContextSnapshot, "playbook_data"> & {
  readonly playbook_state: PlaybookDurableState;
};

export class CheckpointIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointIdentityError";
  }
}

const RUN_CONTEXT_REQUIRED_KEYS = [
  "schema_version",
  "identity",
  "goal",
  "constraints",
  "project_root",
  "trust_profile",
  "status",
  "state_id",
  "previous_state",
  "step_count",
  "max_steps",
  "iteration",
  "max_iterations",
  "iteration_history",
  "clarification_text",
  "met",
  "research",
  "selected_artifacts",
  "pending_directive",
  "pending_branches",
  "terminal_directive",
] as const;

const RUN_CONTEXT_OPTIONAL_KEYS = ["playbook_data"] as const;

const KB_DURABLE_PROJECTION_KEYS = [
  "clarification_text",
  "constraints",
  "durable_schema_version",
  "goal",
  "identity",
  "iteration",
  "iteration_history",
  "max_iterations",
  "max_steps",
  "met",
  "pending_branches",
  "pending_directive",
  "playbook_data",
  "previous_state",
  "research",
  "schema_version",
  "selected_artifacts",
  "state_id",
  "status",
  "step_count",
  "terminal_directive",
  "trust_profile",
] as const;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertNoAbsolutePathInKbProjection(value: unknown): void {
  if (typeof value === "string") {
    if (path.isAbsolute(value)) {
      throw new CheckpointIdentityError("KB durable projection contains an absolute path");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoAbsolutePathInKbProjection(item);
    return;
  }
  if (!isUnknownRecord(value)) return;
  for (const child of Object.values(value)) {
    assertNoAbsolutePathInKbProjection(child);
  }
}

function validateSnapshotWire(value: unknown): RunContextSnapshot {
  if (!isUnknownRecord(value)) {
    throw new Error("checkpoint context must be an object");
  }
  const allowedKeys = new Set<string>([...RUN_CONTEXT_REQUIRED_KEYS, ...RUN_CONTEXT_OPTIONAL_KEYS]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  const missingKeys = RUN_CONTEXT_REQUIRED_KEYS.filter((key) => !Object.hasOwn(value, key));
  if (unknownKeys.length > 0 || missingKeys.length > 0) {
    throw new Error(
      `checkpoint context fields are invalid (missing=${missingKeys.join(",")}; unknown=${unknownKeys.join(",")})`
    );
  }
  if (
    value.playbook_data !== undefined &&
    (value.playbook_data === null ||
      typeof value.playbook_data !== "object" ||
      Array.isArray(value.playbook_data))
  ) {
    throw new Error("checkpoint playbook_data must be an object");
  }
  for (const [name, minimum] of [
    ["step_count", 0],
    ["max_steps", 1],
    ["iteration", 0],
    ["max_iterations", 1],
  ] as const) {
    const numeric = value[name];
    if (!Number.isSafeInteger(numeric) || typeof numeric !== "number" || numeric < minimum) {
      throw new Error(`checkpoint ${name} is invalid`);
    }
  }

  const snapshot = validateContract(RunContextSnapshotSchema, value, "checkpoint context");
  if (snapshot.goal.trim().length === 0) {
    throw new Error("checkpoint goal must be non-empty");
  }
  if (!path.isAbsolute(snapshot.project_root)) {
    throw new Error("checkpoint project_root must be absolute");
  }
  if (snapshot.identity.engine_owner !== "typescript") {
    throw new Error("checkpoint engine_owner must be typescript");
  }
  for (const artifact of snapshot.selected_artifacts) {
    if (artifact.run_id !== snapshot.identity.run_id) {
      throw new Error("checkpoint artifact belongs to another run");
    }
  }
  if (snapshot.pending_directive !== null) {
    const pending = validateDirective(snapshot.pending_directive);
    if (pending.identity.run_id !== snapshot.identity.run_id) {
      throw new Error("pending directive belongs to another run");
    }
  }
  if (snapshot.terminal_directive !== null) {
    const terminal = validateDirective(snapshot.terminal_directive);
    if (terminal.identity.run_id !== snapshot.identity.run_id) {
      throw new Error("terminal directive belongs to another run");
    }
  }
  return snapshot;
}

function decodePlaybookState(snapshot: RunContextSnapshot): PlaybookDurableState {
  const data = snapshot.playbook_data ?? {};
  if (snapshot.identity.playbook === "knowledge-base") {
    return {
      kind: "knowledge-base",
      data: validateContract(
        KnowledgeBasePlaybookDataSchema,
        data,
        "checkpoint knowledge-base playbook_data"
      ),
    };
  }
  if (snapshot.identity.playbook === "research") {
    return { kind: "research", data };
  }
  return { kind: "unsupported", playbook: snapshot.identity.playbook, data };
}

/**
 * Sole codec for orchestration checkpoint state. SQLite/JSON values enter as
 * unknown, are validated here once, and leave as a discriminated domain state.
 */
export const orchestrationDurableStateCodec = {
  decodeSnapshot(value: unknown): DecodedRunContextState {
    const snapshot = validateSnapshotWire(value);
    const { playbook_data: _playbookData, ...core } = snapshot;
    return { ...core, playbook_state: decodePlaybookState(snapshot) };
  },

  encodeSnapshot(state: DecodedRunContextState): RunContextSnapshot {
    const { playbook_state: playbookState, ...core } = state;
    const value = {
      ...core,
      ...(Object.keys(playbookState.data).length > 0
        ? { playbook_data: structuredClone(playbookState.data) }
        : {}),
    };
    const snapshot = validateSnapshotWire(value);
    decodePlaybookState(snapshot);
    return snapshot;
  },

  decodeCheckpoint(
    value: unknown,
    options: { readonly playbook: string; readonly projectRoot?: string }
  ): DecodedRunContextState {
    if (options.playbook !== "knowledge-base") {
      return this.decodeSnapshot(value);
    }
    if (!isUnknownRecord(value)) {
      throw new CheckpointIdentityError("KB durable projection is not an object");
    }
    if (
      !sameKeys(sortedKeys(value), [...KB_DURABLE_PROJECTION_KEYS].sort()) ||
      value.durable_schema_version !== 1 ||
      Object.hasOwn(value, "project_root")
    ) {
      throw new CheckpointIdentityError("KB durable projection fields or version are invalid");
    }
    if (options.projectRoot === undefined) {
      throw new CheckpointIdentityError(
        "KB durable projection cannot load without the current trusted project root"
      );
    }
    assertNoAbsolutePathInKbProjection(value);
    const { durable_schema_version: _durableVersion, ...snapshot } = value;
    const decoded = this.decodeSnapshot({ ...snapshot, project_root: options.projectRoot });
    if (decoded.playbook_state.kind !== "knowledge-base") {
      throw new CheckpointIdentityError("KB durable projection has another playbook identity");
    }
    return decoded;
  },

  encodeCheckpoint(snapshotValue: unknown): RunContextSnapshot | Record<string, unknown> {
    const state = this.decodeSnapshot(snapshotValue);
    const snapshot = this.encodeSnapshot(state);
    if (state.playbook_state.kind !== "knowledge-base") {
      return snapshot;
    }
    const { project_root: projectRoot, ...withoutProjectRoot } = snapshot;
    const projection = {
      durable_schema_version: 1,
      ...withoutProjectRoot,
      playbook_data: snapshot.playbook_data ?? {},
    };
    if (!sameKeys(sortedKeys(projection), [...KB_DURABLE_PROJECTION_KEYS].sort())) {
      throw new CheckpointIdentityError("KB durable projection fields are not closed");
    }
    assertNoAbsolutePathInKbProjection(projection);
    this.decodeCheckpoint(projection, { playbook: "knowledge-base", projectRoot });
    return projection;
  },
};

/** JSON-compatible view used only for compatibility access to unrecognized fields. */
export function playbookDataJson(state: PlaybookDurableState): JsonObject {
  return state.data;
}
