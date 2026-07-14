/**
 * Penny Compact Artifact — Zod Schemas (Canonical Runtime Source)
 *
 * v2.1.0: the artifact is a resumability checkpoint — a prose brief plus
 * pointers into durable stores (engine checkpointer, mempalace, KG,
 * outcome ledger). These schemas are the single source of truth for
 * TypeScript types AND runtime validators.
 *
 * 2.3.0 is an ADDITIVE bump: model-owned-prose provenance (`summary_source`,
 * `summary_model`, `prose_summary`), session-scoping transparency
 * (`scoped_session_ids`), and the cross-session run bucket
 * (`other_session_runs`). Every new field is optional, so a 2.1.0/2.2.0-shaped
 * artifact still validates unchanged.
 *
 * 2.1.0 was an ADDITIVE bump over 2.0.0: every new field is optional, so a
 * 2.0.0-shaped artifact still validates unchanged. New in 2.1.0:
 *   - `dominant_skill.superseded` — a completed skill whose goal was
 *     displaced by a fresher user pivot (listed under Active Skill, but it
 *     no longer sets Goal).
 *   - `current_work` / `next_steps` — rendered as prose sections when
 *     derivable from live signal.
 *   - `metadata.compaction_reason` / `metadata.custom_instructions` — the
 *     named observability sink for the triggering reason and focus hint.
 *   - `metadata.goal_streak` — consecutive byte-identical Goal count, for
 *     the goal-stagnation regression canary (observational only).
 */

import { z } from "zod";

/** The current artifact schema version. Single source of truth. */
export const SCHEMA_VERSION = "2.3.0" as const;

/** Which path produced the prose brief: the summarization model, or the
 *  deterministic LOAN fallback when no model was reachable. */
export const SummarySourceEnum = z.enum(["model", "deterministic_fallback"]);

/** The reason Pi triggered this compaction (mirrors Pi's event.reason). */
export const CompactionReasonEnum = z.enum(["manual", "threshold", "overflow"]);

// ============================================================
// Enums
// ============================================================

export const PendingStateEnum = z.enum([
  "UNKNOWN_STATE",
  "awaiting_clarification",
  "verification_required",
]);
export const ConfidenceEnum = z.enum(["CERTAIN", "PROBABLE", "POSSIBLE", "UNCERTAIN"]);

// ============================================================
// Sub-Schemas
// ============================================================

export const PendingStateSchema = z.object({
  state: PendingStateEnum,
  previous_state: z.string().min(1),
  mempalace_drawer_id: z.string().min(1),
  question_summary: z.string().max(300),
  turn_id: z.string().min(1),
});

export const DecisionRefSchema = z.object({
  decision_id: z.string().min(1),
  summary: z.string().max(200),
  outcome_room: z.string().min(1),
  confidence: ConfidenceEnum,
});

export const ErrorRefSchema = z.object({
  error_type: z.string().min(1),
  message: z.string().max(300),
  turn_id: z.string().min(1),
  mempalace_drawer_id: z.string().min(1),
  resolved: z.boolean(),
});

/**
 * A reference to an orchestration-engine run, read from the durable
 * run_id checkpointer (.penny/orchestration.db). The checkpointer is the
 * source of truth for run state — post-compaction Penny resumes a run
 * with skill(skill_name=<playbook>, goal=..., resumeFrom=<session_id>).
 */
export const EngineRunRefSchema = z.object({
  run_id: z.string().min(1),
  session_id: z.string().min(1),
  playbook: z.string().min(1),
  current_state_id: z.string().min(1),
  status: z.enum(["running", "awaiting_user", "complete", "error"]),
  goal: z.string().max(500).optional(),
  clarification_text: z.string().max(300).optional(),
  updated_at: z.string(),
});

// ============================================================
// Skill Invocation Reference (new v1.1.0)
// ============================================================

export const SkillInvocationRefSchema = z.object({
  skill_name: z.string().min(1),
  session_id: z.string().min(1),
  goal: z.string().min(1).max(500),
  completed: z.boolean(),
  result_summary: z.string().max(500).optional(),
  // 2.1.0: set when a COMPLETED skill's goal was displaced by a fresher
  // user pivot. The skill stays listed under Active Skill, but Goal is
  // sourced from the later user message instead.
  superseded: z.boolean().optional(),
});

export const MempalaceRoomRefSchema = z.object({
  wing: z.string().min(1),
  room: z.string().min(1),
  drawer_ids: z.array(z.string().min(1)).max(5),
  last_updated: z.string().datetime(),
  dominant_for_session: z.boolean().optional(),
});

export const KGEntityRefSchema = z.object({
  entity_id: z.string().min(1),
  entity_type: z.string().min(1),
  relevant_predicates: z.array(z.string()),
  last_verified: z.string().datetime().optional(),
  stale: z.boolean().optional(),
  valid_from: z.string().datetime().optional(),
});

export const ToolCallExampleSchema = z.object({
  tool: z.string().min(1),
  params: z.record(z.string(), z.any()),
  successful: z.boolean(),
});

export const ToolErrorRecoverySchema = z.object({
  tool: z.string().min(1),
  failed_params: z.record(z.string(), z.any()),
  error_message: z.string().max(200),
  corrected_params: z.record(z.string(), z.any()),
});

export const FileContextSchema = z.object({
  read: z.array(z.string()).max(30),
  modified: z.array(z.string()).max(30),
});

export const EvictionRecordSchema = z.object({
  field: z.string().min(1),
  evicted_count: z.number().int().nonnegative(),
  strategy: z.string().min(1),
  timestamp: z.string().datetime(),
});

export const BoundaryShiftRecordSchema = z.object({
  previous: z.string().min(1),
  current: z.string().min(1),
  compaction_seq: z.number().int().nonnegative(),
});

export const PiBoundaryDebugSchema = z.object({
  first_kept_entry_id: z.string().min(1),
  tokens_before: z.number().int().nonnegative(),
  boundary_shift: BoundaryShiftRecordSchema.optional(),
});

export const ArtifactMetadataSchema = z.object({
  eviction_log: z.array(EvictionRecordSchema).max(10),
  pi_boundary: PiBoundaryDebugSchema.optional(),
  // 2.1.0 named observability sink: what triggered the compaction and the
  // focus hint the user passed (e.g. `/compact <focus>`). Additive/optional.
  compaction_reason: CompactionReasonEnum.optional(),
  custom_instructions: z.string().max(2000).optional(),
  // 2.1.0: consecutive compactions with a byte-identical Goal, for the
  // goal-stagnation regression canary. Observational; never gates behavior.
  goal_streak: z.number().int().nonnegative().optional(),
});

// ============================================================
// Top-Level Artifact Schema
// ============================================================

export const PennyCompactArtifactSchema = z.object({
  // IDENTITY
  schema_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  session_id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  compaction_seq: z.number().int().nonnegative(),
  compaction_timestamp: z.string().datetime(),

  // ACTIVE STATE
  goal: z.string().min(1).max(500),
  constraints: z.array(z.string().min(1).max(200)).max(20),
  preferences: z.array(z.string().min(1)).max(10),
  pending: PendingStateSchema.nullable(),

  // WORK CONTEXT (new 2.1.0 — rendered as prose when derivable, else omitted)
  current_work: z.string().min(1).max(1000).optional(),
  next_steps: z.array(z.string().min(1).max(300)).max(10).optional(),

  // DECISIONS & OUTCOMES
  decisions: z.array(DecisionRefSchema).max(20),
  errors: z.array(ErrorRefSchema).max(10),

  // ENGINE ORCHESTRATION (checkpointer is the source of truth)
  engine_runs: z.array(EngineRunRefSchema).max(5),

  // PROVENANCE MAPS
  mempalace_rooms: z.array(MempalaceRoomRefSchema).max(10),
  kg_entities: z.array(KGEntityRefSchema).max(20),
  files: FileContextSchema,

  // SKILL TRACKING (new v1.1.0)
  dominant_skill: SkillInvocationRefSchema.optional(),

  // TOOL USAGE PATTERNS (for weak tool-callers like Kimi/GLM)
  tool_calls: z.array(ToolCallExampleSchema).max(15),
  tool_error_recovery: z.array(ToolErrorRecoverySchema).max(3),

  // METADATA
  metadata: ArtifactMetadataSchema,

  // ============================================================
  // 2.3.0 (additive, all optional): model-owned-prose provenance +
  // session-scoping transparency + the cross-session run bucket. A
  // 2.1.0/2.2.0-shaped artifact still validates unchanged.
  // ============================================================
  /** Which path produced the prose brief (model vs deterministic fallback). */
  summary_source: SummarySourceEnum.optional(),
  /** provider/model-id of the summarization model, when the model path ran. */
  summary_model: z.string().max(200).optional(),
  /** The session ids the grounded state was scoped to (skill results ∪ their
   *  checkpointer rows ∪ prior-refs ids). Transparency for the archive. */
  scoped_session_ids: z.array(z.string().min(1)).max(50).optional(),
  /** Pending runs from OTHER sessions — never in the prose, surfaced only in
   *  RESUME-REFS under an explicit "verify before resuming" label. */
  other_session_runs: z.array(EngineRunRefSchema).max(10).optional(),
  /** The model prose brief, archived so compaction quality is measurable
   *  offline (the Ablate substrate: compare summary_source populations). */
  prose_summary: z.string().max(20000).optional(),
});

// ============================================================
// Type Exports (generated from zod schemas)
// ============================================================

export type PennyCompactArtifact = z.infer<typeof PennyCompactArtifactSchema>;
export type PendingState = z.infer<typeof PendingStateSchema>;
export type DecisionRef = z.infer<typeof DecisionRefSchema>;
export type ErrorRef = z.infer<typeof ErrorRefSchema>;
export type EngineRunRef = z.infer<typeof EngineRunRefSchema>;
export type SkillInvocationRef = z.infer<typeof SkillInvocationRefSchema>;
export type MempalaceRoomRef = z.infer<typeof MempalaceRoomRefSchema>;
export type KGEntityRef = z.infer<typeof KGEntityRefSchema>;
export type ToolCallExample = z.infer<typeof ToolCallExampleSchema>;
export type ToolErrorRecovery = z.infer<typeof ToolErrorRecoverySchema>;
export type FileContext = z.infer<typeof FileContextSchema>;
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;
export type EvictionRecord = z.infer<typeof EvictionRecordSchema>;
export type BoundaryShiftRecord = z.infer<typeof BoundaryShiftRecordSchema>;
export type CompactionReason = z.infer<typeof CompactionReasonEnum>;
export type SummarySource = z.infer<typeof SummarySourceEnum>;
