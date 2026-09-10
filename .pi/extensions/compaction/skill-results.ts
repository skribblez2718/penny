import { parseArtifactDispatchPause } from "@penny/orchestration/source";
import { z } from "zod";

import type { SkillResultStatus } from "./schema.js";

const MAX_TEXT_BYTES = 32_768;
const MAX_COLLECTION_ITEMS = 128;
const MAX_RESULT_NODES = 128;
const MAX_RESULT_DEPTH = 4;

const NonEmptyTextSchema = z.string().min(1).max(MAX_TEXT_BYTES);
const TextSchema = z.string().max(MAX_TEXT_BYTES);
const UnknownRecordSchema = z.record(z.string(), z.unknown());

const ResultPayloadSchema = UnknownRecordSchema.superRefine((value, ctx) => {
  if (typeof value.met !== "boolean") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "result.met must be boolean" });
  }
  if (value.schema_version !== undefined && value.schema_version !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "result.schema_version is unsupported",
    });
  }
});

const LegacyAdapterDispatchPauseSchema = z
  .object({
    schema_version: z.literal(1),
    action: z.literal("paused"),
    code: z.enum(["ARTIFACT_DISPATCH_PAUSED", "ARTIFACT_DISPATCH_MODE_INVALID"]),
    reason: NonEmptyTextSchema,
    retryable: z.literal(true),
    dispatch_mode: z.literal("paused"),
    run_status: NonEmptyTextSchema,
    state_id: NonEmptyTextSchema,
    session_id: TextSchema,
    run_id: TextSchema,
    recovery: z
      .object({
        action: z.literal("recover"),
        run_id: TextSchema,
        requires_dispatch_mode: z.literal("active"),
        checkpoint_preserved: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.recovery.run_id !== value.run_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "dispatch pause recovery run_id must match",
      });
    }
  });

const EngineDispatchPauseSchema = z.unknown().superRefine((value, ctx) => {
  try {
    parseArtifactDispatchPause(value);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "engine dispatch pause is invalid",
    });
  }
});

/** Current engine facts plus the one identified historical extension adapter shape. */
const DispatchPauseSchema = z.union([EngineDispatchPauseSchema, LegacyAdapterDispatchPauseSchema]);

const EscalationQuestionSchema = z
  .object({
    approval_run_id: TextSchema.optional(),
  })
  .passthrough();

const EscalationSchema = z
  .object({
    questions: z.array(EscalationQuestionSchema).min(1).max(32),
  })
  .passthrough();

// Keep the current-era boundary independent from the historical adapter. Its
// established admission behavior must not broaden or narrow when legacy support changes.
const CurrentSkillResultBaseFields = {
  success: z.boolean(),
  session_id: TextSchema,
  skill_name: NonEmptyTextSchema,
  state: NonEmptyTextSchema,
  plan: z.unknown().optional(),
  plan_steps: z.array(z.unknown()).max(MAX_COLLECTION_ITEMS).optional(),
  requires_approval: z.boolean().optional(),
  session_room: TextSchema.optional(),
  steps_total: z.number().int().nonnegative(),
  agents_invoked: z.array(NonEmptyTextSchema).max(MAX_COLLECTION_ITEMS),
  mode: NonEmptyTextSchema.optional(),
  chain_step: z.number().int().nonnegative().optional(),
  chain_total: z.number().int().nonnegative().optional(),
  chain_session_id: TextSchema.optional(),
  chain_error_step: z.number().int().nonnegative().optional(),
  chain_results: z.array(z.unknown()).max(MAX_COLLECTION_ITEMS).optional(),
  resumable: z.boolean().optional(),
  parallel_results: z.array(z.unknown()).max(MAX_COLLECTION_ITEMS).optional(),
  escalation: EscalationSchema.optional(),
} as const;

const CurrentOnlySkillResultFields = {
  refusal_code: NonEmptyTextSchema.optional(),
  result: ResultPayloadSchema.optional(),
  output_artifact_ref: z.unknown().optional(),
  best_partial_artifact_refs: z.array(z.unknown()).max(MAX_COLLECTION_ITEMS).optional(),
  retriable: z.boolean().optional(),
  dispatch_pause: DispatchPauseSchema.optional(),
  recovery: z.unknown().optional(),
} as const;

const CURRENT_RESULT_MARKERS = Object.keys(CurrentOnlySkillResultFields);
const CURRENT_ESCALATION_QUESTION_MARKERS = [
  "type",
  "artifact_ref",
  "approval_challenge",
  "approval_run_id",
  "approval_gate_id",
  "questionnaire_transport_ref",
  "rendered_questions_digest",
] as const;

function hasOwnCurrentResultMarker(value: Record<string, unknown>): boolean {
  if (CURRENT_RESULT_MARKERS.some((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    return true;
  }

  const escalation = isRecord(value.escalation) ? value.escalation : undefined;
  const questions = Array.isArray(escalation?.questions) ? escalation.questions : [];
  return questions.some(
    (question) =>
      isRecord(question) &&
      CURRENT_ESCALATION_QUESTION_MARKERS.some((key) =>
        Object.prototype.hasOwnProperty.call(question, key)
      )
  );
}

/**
 * Current results carry at least one field introduced with the engine-owned result boundary.
 * Requiring that marker makes this schema disjoint from the strict historical schema below.
 */
const CurrentSkillResultDetailsSchema = z
  .object({
    ...CurrentSkillResultBaseFields,
    ...CurrentOnlySkillResultFields,
    errors: z.array(TextSchema).max(MAX_COLLECTION_ITEMS),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!hasOwnCurrentResultMarker(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "current skill result requires an engine-era marker field",
      });
    }
  });

const LegacyEscalationQuestionOptionSchema = z
  .object({
    value: TextSchema,
    label: TextSchema,
    description: TextSchema.optional(),
  })
  .strict();

const LegacyEscalationQuestionSchema = z
  .object({
    id: TextSchema,
    label: TextSchema,
    prompt: TextSchema,
    options: z.array(LegacyEscalationQuestionOptionSchema).max(MAX_COLLECTION_ITEMS).optional(),
    allowOther: z.boolean().optional(),
  })
  .strict();

const LegacyEscalationSchema = z
  .object({
    questions: z.array(LegacyEscalationQuestionSchema).max(MAX_COLLECTION_ITEMS),
    unknown_reason: TextSchema.optional(),
    previous_state: TextSchema.optional(),
  })
  .strict();

/**
 * Build the exact pre-engine `SkillResult` recursively while retaining the
 * parser's fixed nesting ceiling. At the ceiling, recursive collections may be
 * present only when empty.
 */
function createLegacySkillResultDetailsSchema(depth: number): z.ZodType<unknown> {
  const nestedResultsSchema =
    depth < MAX_RESULT_DEPTH
      ? z
          .array(createLegacySkillResultDetailsSchema(depth + 1))
          .max(MAX_COLLECTION_ITEMS)
          .optional()
      : z.array(z.never()).max(0).optional();

  return z
    .object({
      success: z.boolean(),
      session_id: TextSchema,
      skill_name: TextSchema,
      state: TextSchema,
      plan: UnknownRecordSchema.optional(),
      plan_steps: z.array(UnknownRecordSchema).max(MAX_COLLECTION_ITEMS).optional(),
      requires_approval: z.boolean(),
      session_room: TextSchema.optional(),
      steps_total: z.number().finite(),
      agents_invoked: z.array(TextSchema).max(MAX_COLLECTION_ITEMS),
      errors: z.array(TextSchema).max(MAX_COLLECTION_ITEMS),
      mode: z.enum(["single", "parallel", "chain"]).optional(),
      chain_step: z.number().finite().optional(),
      chain_total: z.number().finite().optional(),
      chain_session_id: TextSchema.optional(),
      chain_error_step: z.number().finite().optional(),
      chain_results: nestedResultsSchema,
      resumable: z.boolean().optional(),
      parallel_results: nestedResultsSchema,
      escalation: LegacyEscalationSchema.optional(),
    })
    .strict();
}

/**
 * The sole historical compatibility shape: `SkillResult` from repository
 * commit 12e8c32922bae2db0da7cc706322d10b2eccb81d. Required/optional fields and
 * nested field types match that source exactly; notably, `requires_approval`
 * is a required boolean. Current markers are handled exclusively by the
 * current schema before this adapter, so malformed current-like data cannot
 * fall through to legacy admission.
 */
const LegacySkillResultDetailsSchema = createLegacySkillResultDetailsSchema(0);

export type SkillResultFormat = "current" | "legacy";

export interface ParsedSkillResultDetails {
  format: SkillResultFormat;
  status: SkillResultStatus;
  success: boolean;
  sessionId?: string;
  skillName: string;
  state: string;
  mode?: string;
  summary?: string;
  details: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedState(details: Record<string, unknown>): string {
  return typeof details.state === "string" ? details.state.trim().toLowerCase() : "";
}

function classify(details: Record<string, unknown>): SkillResultStatus {
  const success = details.success === true;
  const state = normalizedState(details);
  const result = isRecord(details.result) ? details.result : undefined;

  if (result) {
    if (typeof result.met !== "boolean" || result.met !== success) return "unknown";
    if (state === "complete") return success ? "success" : "unknown";
    if (state === "incomplete" || state === "partial") {
      return success ? "unknown" : "incomplete";
    }
    if (state === "cancelled") return success ? "unknown" : "cancelled";
    if (state === "error" || state === "failed") return success ? "unknown" : "failure";
    return "unknown";
  }

  if (details.dispatch_pause !== undefined) return success ? "unknown" : "paused";
  if (state === "complete") return success ? "success" : "unknown";
  if (state === "incomplete" || state === "partial") {
    return success ? "unknown" : "incomplete";
  }
  if (state === "cancelled") return success ? "unknown" : "cancelled";
  if (state === "error" || state === "failed") return success ? "unknown" : "failure";
  if (details.escalation !== undefined || state === "paused" || state.startsWith("awaiting")) {
    return success ? "unknown" : "paused";
  }

  // Older session results used workflow-state names (for example, "report")
  // instead of terminal labels. Their typed success flag is the only terminal signal.
  if (success) return "success";
  const errors = Array.isArray(details.errors) ? details.errors : [];
  return errors.length > 0 ? "failure" : "unknown";
}

function extractSummary(details: Record<string, unknown>): string | undefined {
  if (typeof details.plan_summary === "string" && details.plan_summary.trim()) {
    return details.plan_summary.trim().slice(0, 500);
  }
  for (const candidate of [details.plan_summary, details.plan]) {
    if (!isRecord(candidate)) continue;
    for (const key of ["title", "goal", "summary"] as const) {
      const value = candidate[key];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500);
    }
  }
  return undefined;
}

function normalize(
  details: Record<string, unknown>,
  format: SkillResultFormat
): ParsedSkillResultDetails {
  const sessionId =
    typeof details.session_id === "string" && details.session_id ? details.session_id : undefined;
  const summary = extractSummary(details);
  return {
    format,
    status: classify(details),
    success: details.success === true,
    ...(sessionId ? { sessionId } : {}),
    skillName: String(details.skill_name),
    state: String(details.state),
    ...(typeof details.mode === "string" ? { mode: details.mode } : {}),
    ...(summary ? { summary } : {}),
    details,
  };
}

/** Parse structured details only. Prose content is deliberately not a fallback. */
export function parseSkillResultDetails(value: unknown): ParsedSkillResultDetails | null {
  if (isRecord(value) && hasOwnCurrentResultMarker(value)) {
    const current = CurrentSkillResultDetailsSchema.safeParse(value);
    return current.success && isRecord(current.data) ? normalize(current.data, "current") : null;
  }

  const legacy = LegacySkillResultDetailsSchema.safeParse(value);
  if (legacy.success && isRecord(legacy.data)) {
    return normalize(legacy.data, "legacy");
  }
  return null;
}

/**
 * Traverse only schema-validated current/legacy result nodes with strict depth and
 * count ceilings. Malformed or unknown-version children are omitted.
 */
export function collectValidatedSkillResultNodes(
  root: ParsedSkillResultDetails
): ParsedSkillResultDetails[] {
  const collected: ParsedSkillResultDetails[] = [];
  const queue: Array<{ node: ParsedSkillResultDetails; depth: number }> = [
    { node: root, depth: 0 },
  ];

  while (queue.length > 0 && collected.length < MAX_RESULT_NODES) {
    const item = queue.shift();
    if (!item) break;
    collected.push(item.node);
    if (item.depth >= MAX_RESULT_DEPTH) continue;

    for (const key of ["parallel_results", "chain_results"] as const) {
      const children = item.node.details[key];
      if (!Array.isArray(children)) continue;
      for (const child of children) {
        if (collected.length + queue.length >= MAX_RESULT_NODES) break;
        const parsed = parseSkillResultDetails(child);
        if (parsed) queue.push({ node: parsed, depth: item.depth + 1 });
      }
    }
  }
  return collected;
}
