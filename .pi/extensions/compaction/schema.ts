/**
 * Penny compaction checkpoint schemas.
 *
 * Version 3 removes semantic memory/session discovery. Recovery state is a
 * strict set of exact orchestration run IDs and immutable artifact references
 * read from TypeScript v2 RunContext.selected_artifacts checkpoints.
 */

import { createHash } from "node:crypto";

import { z } from "zod";

export const SCHEMA_VERSION = "3.0.0" as const;
export const RESUME_REFS_VERSION = 2 as const;
export const ARTIFACT_REF_SCHEMA_VERSION = 1 as const;

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? -1;
    return codePoint < 32 || codePoint === 127;
  });
}

function compareUnicode(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? -1);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? -1);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return (leftPoints[index] ?? -1) - (rightPoints[index] ?? -1);
    }
  }
  return leftPoints.length - rightPoints.length;
}

const CanonicalStringSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim() && !hasControlCharacter(value), {
    message: "must be a canonical non-control string",
  });
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const ArtifactIdSchema = z.string().regex(/^art_[0-9a-f]{64}$/);

export const SummarySourceEnum = z.enum(["model", "deterministic_fallback"]);
export const CompactionReasonEnum = z.enum(["manual", "threshold", "overflow"]);
export const PendingStateEnum = z.enum([
  "UNKNOWN_STATE",
  "awaiting_clarification",
  "verification_required",
]);

export const PendingStateSchema = z
  .object({
    state: PendingStateEnum,
    previous_state: CanonicalStringSchema,
    question_summary: z.string().max(300),
    turn_id: CanonicalStringSchema,
  })
  .strict();

export const ErrorRefSchema = z
  .object({
    error_type: CanonicalStringSchema,
    message: z.string().max(300),
    turn_id: CanonicalStringSchema,
    resolved: z.boolean(),
  })
  .strict();

export const EngineRunRefSchema = z
  .object({
    run_id: CanonicalStringSchema,
    session_id: CanonicalStringSchema,
    playbook: CanonicalStringSchema,
    current_state_id: CanonicalStringSchema,
    status: z.enum(["running", "awaiting_user"]),
    goal: z.string().max(500).optional(),
    clarification_text: z.string().max(300).optional(),
    updated_at: z.string(),
  })
  .strict();

export const ArtifactRefSchema = z
  .object({
    schema_version: z.literal(ARTIFACT_REF_SCHEMA_VERSION),
    artifact_id: ArtifactIdSchema,
    run_id: CanonicalStringSchema,
    phase: CanonicalStringSchema,
    branch_id: CanonicalStringSchema.nullable(),
    kind: z.string().regex(/^[a-z][a-z0-9-]*$/),
    operation_id: CanonicalStringSchema,
    version: z.number().int().positive(),
    producer: CanonicalStringSchema,
    consumer_scope: z.array(CanonicalStringSchema).max(100),
    media_type: CanonicalStringSchema,
    byte_length: z.number().int().nonnegative(),
    content_digest: DigestSchema,
    store_ref: z.string().regex(/^artifact:\/\/sha256\/[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine((ref, ctx) => {
    if (new Set(ref.consumer_scope).size !== ref.consumer_scope.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "consumer_scope contains duplicates" });
    }
    const sorted = [...ref.consumer_scope].sort(compareUnicode);
    if (sorted.some((value, index) => value !== ref.consumer_scope[index])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "consumer_scope is not sorted" });
    }
    if (ref.store_ref !== `artifact://sha256/${ref.content_digest}`) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "store_ref does not match digest" });
    }
    const identity = JSON.stringify({
      branch_id: ref.branch_id,
      kind: ref.kind,
      operation_id: ref.operation_id,
      phase: ref.phase,
      run_id: ref.run_id,
      version: ref.version,
    });
    const expectedId = `art_${createHash("sha256").update(identity, "utf8").digest("hex")}`;
    if (ref.artifact_id !== expectedId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "artifact_id does not match canonical identity",
      });
    }
  });

export const RunResumeRefSchema = z
  .object({
    type: z.literal("run"),
    run_id: CanonicalStringSchema,
  })
  .strict();
export const ArtifactResumeRefSchema = z
  .object({
    type: z.literal("artifact"),
    artifact_id: ArtifactIdSchema,
    digest: DigestSchema,
  })
  .strict();
export const DurableMemoryResumeRefSchema = z
  .object({
    type: z.literal("memory"),
    memory_id: CanonicalStringSchema,
  })
  .strict();
export const ResumeRefSchema = z.discriminatedUnion("type", [
  RunResumeRefSchema,
  ArtifactResumeRefSchema,
  DurableMemoryResumeRefSchema,
]);
export const ResumeRefSetSchema = z
  .object({
    version: z.literal(RESUME_REFS_VERSION),
    refs: z.array(ResumeRefSchema).max(250),
  })
  .strict();

export const SkillInvocationRefSchema = z
  .object({
    skill_name: CanonicalStringSchema,
    session_id: CanonicalStringSchema.optional(),
    goal: z.string().min(1).max(500),
    completed: z.boolean(),
    result_summary: z.string().max(500).optional(),
    superseded: z.boolean().optional(),
  })
  .strict();

export const ToolCallExampleSchema = z
  .object({
    tool: CanonicalStringSchema,
    params: z.record(z.string(), z.unknown()),
    successful: z.boolean(),
  })
  .strict();
export const ToolErrorRecoverySchema = z
  .object({
    tool: CanonicalStringSchema,
    failed_params: z.record(z.string(), z.unknown()),
    error_message: z.string().max(200),
    corrected_params: z.record(z.string(), z.unknown()),
  })
  .strict();
export const FileContextSchema = z
  .object({
    read: z.array(z.string()).max(30),
    modified: z.array(z.string()).max(30),
  })
  .strict();
export const EvictionRecordSchema = z
  .object({
    field: CanonicalStringSchema,
    evicted_count: z.number().int().nonnegative(),
    strategy: CanonicalStringSchema,
    timestamp: z.string().datetime(),
  })
  .strict();
export const BoundaryShiftRecordSchema = z
  .object({
    previous: CanonicalStringSchema,
    current: CanonicalStringSchema,
    compaction_seq: z.number().int().nonnegative(),
  })
  .strict();
export const PiBoundaryDebugSchema = z
  .object({
    first_kept_entry_id: CanonicalStringSchema,
    tokens_before: z.number().int().nonnegative(),
    boundary_shift: BoundaryShiftRecordSchema.optional(),
  })
  .strict();
export const ResultBudgetTelemetrySchema = z
  .object({
    serialized_bytes: z.number().int().nonnegative(),
    serialized_characters: z.number().int().nonnegative(),
    estimated_tokens: z.number().int().nonnegative(),
    release_minimum_context_headroom_tokens: z.number().int().positive(),
    required_reserved_after_result_tokens: z.number().int().nonnegative(),
    estimated_reserved_after_result_tokens: z.number().int(),
    reserve_invariant_preserved: z.boolean(),
  })
  .strict();
export const CompactionCorrelationSchema = z
  .object({
    status: z.literal("not_evaluated"),
    keys: z.array(CanonicalStringSchema).max(21),
  })
  .strict();
export const ArtifactMetadataSchema = z
  .object({
    eviction_log: z.array(EvictionRecordSchema).max(10),
    pi_boundary: PiBoundaryDebugSchema.optional(),
    result_budget: ResultBudgetTelemetrySchema.optional(),
    compaction_correlation: CompactionCorrelationSchema.optional(),
    compaction_reason: CompactionReasonEnum.optional(),
    custom_instructions: z.string().max(2000).optional(),
    goal_streak: z.number().int().nonnegative().optional(),
    checkpoint_issues: z.array(z.string().max(300)).max(20).optional(),
  })
  .strict();

export const PennyCompactArtifactSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    session_id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    compaction_seq: z.number().int().nonnegative(),
    compaction_timestamp: z.string().datetime(),

    goal: z.string().min(1).max(500),
    constraints: z.array(z.string().min(1).max(200)).max(20),
    preferences: z.array(z.string().min(1)).max(10),
    pending: PendingStateSchema.nullable(),
    current_work: z.string().min(1).max(1000).optional(),
    next_steps: z.array(z.string().min(1).max(300)).max(10).optional(),

    errors: z.array(ErrorRefSchema).max(10),
    engine_runs: z.array(EngineRunRefSchema).max(20),
    artifact_refs: z.array(ArtifactRefSchema).max(200),
    resume_refs: ResumeRefSetSchema,
    files: FileContextSchema,
    dominant_skill: SkillInvocationRefSchema.optional(),
    tool_calls: z.array(ToolCallExampleSchema).max(15),
    tool_error_recovery: z.array(ToolErrorRecoverySchema).max(3),
    metadata: ArtifactMetadataSchema,

    summary_source: SummarySourceEnum.optional(),
    summary_model: z.string().max(200).optional(),
    prose_summary: z.string().max(20000).optional(),
  })
  .strict();

export type PennyCompactArtifact = z.infer<typeof PennyCompactArtifactSchema>;
export type PendingState = z.infer<typeof PendingStateSchema>;
export type ErrorRef = z.infer<typeof ErrorRefSchema>;
export type EngineRunRef = z.infer<typeof EngineRunRefSchema>;
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type ResumeRef = z.infer<typeof ResumeRefSchema>;
export type ResumeRefSet = z.infer<typeof ResumeRefSetSchema>;
export type SkillInvocationRef = z.infer<typeof SkillInvocationRefSchema>;
export type ToolCallExample = z.infer<typeof ToolCallExampleSchema>;
export type ToolErrorRecovery = z.infer<typeof ToolErrorRecoverySchema>;
export type FileContext = z.infer<typeof FileContextSchema>;
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;
export type ResultBudgetTelemetry = z.infer<typeof ResultBudgetTelemetrySchema>;
export type CompactionCorrelation = z.infer<typeof CompactionCorrelationSchema>;
export type EvictionRecord = z.infer<typeof EvictionRecordSchema>;
export type BoundaryShiftRecord = z.infer<typeof BoundaryShiftRecordSchema>;
export type CompactionReason = z.infer<typeof CompactionReasonEnum>;
export type SummarySource = z.infer<typeof SummarySourceEnum>;
