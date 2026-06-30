/**
 * Penny Compact Artifact — Zod Schemas (Canonical Runtime Source)
 *
 * Phase 2: Runtime validation using zod.
 * These schemas are the single source of truth for TypeScript types
 * AND runtime validators.
 */

import { z } from "zod";

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

export const AgentRefSchema = z.object({
  name: z.string().min(1),
  session_id: z.string().min(1),
  phase: z.string().min(1),
  complete: z.boolean(),
  source: z.enum(["mempalace_summary", "inferred"]).optional(),
});

export const OrchestratorStateSchema = z.object({
  skill: z.string().min(1),
  session_id: z.string().min(1),
  current_phase: z.string().min(1),
  completed_phases: z.array(z.string()),
  next_phase: z.string().nullable(),
  mempalace_room: z.string().min(1),
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

  // DECISIONS & OUTCOMES
  decisions: z.array(DecisionRefSchema).max(20),
  errors: z.array(ErrorRefSchema).max(10),

  // AGENT ORCHESTRATION
  agents_invoked: z.array(AgentRefSchema).max(10),
  orchestrator_state: OrchestratorStateSchema.nullable(),

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
});

// ============================================================
// Type Exports (generated from zod schemas)
// ============================================================

export type PennyCompactArtifact = z.infer<typeof PennyCompactArtifactSchema>;
export type PendingState = z.infer<typeof PendingStateSchema>;
export type DecisionRef = z.infer<typeof DecisionRefSchema>;
export type ErrorRef = z.infer<typeof ErrorRefSchema>;
export type AgentRef = z.infer<typeof AgentRefSchema>;
export type OrchestratorState = z.infer<typeof OrchestratorStateSchema>;
export type SkillInvocationRef = z.infer<typeof SkillInvocationRefSchema>;
export type MempalaceRoomRef = z.infer<typeof MempalaceRoomRefSchema>;
export type KGEntityRef = z.infer<typeof KGEntityRefSchema>;
export type ToolCallExample = z.infer<typeof ToolCallExampleSchema>;
export type ToolErrorRecovery = z.infer<typeof ToolErrorRecoverySchema>;
export type FileContext = z.infer<typeof FileContextSchema>;
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;
export type EvictionRecord = z.infer<typeof EvictionRecordSchema>;
export type BoundaryShiftRecord = z.infer<typeof BoundaryShiftRecordSchema>;
