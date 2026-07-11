/**
 * Penny Custom Compaction Extension
 *
 * Goal: when Pi compacts, Penny resumes with no work lost. The summary
 * spliced into context has two parts:
 *
 *   1. A prose brief — goal, in-flight runs, pending state, decisions —
 *      so Penny re-orients by reading, not parsing.
 *   2. A [RESUME-REFS] appendix — run_id + engine state, mempalace
 *      room/drawer IDs, decision IDs, KG entities, verbatim tool-call
 *      examples — so any detail that didn't fit the token budget can be
 *      dereferenced from durable memory instead of being lost.
 *
 * Sources of truth:
 *   - Orchestration run state comes from the engine's durable run_id
 *     checkpointer (.penny/orchestration.db) — never reconstructed from
 *     mempalace drawer text.
 *   - Mempalace/KG/outcome-ledger queries provide POINTERS to what agents
 *     wrote, not reconstructed state.
 *
 * Failure policy: degrade, never abandon. Budget overflow triggers
 * progressively tighter eviction; validation failure logs loudly but the
 * prose summary is still emitted. Pi's default summary is never the
 * fallback on a path this extension controls.
 *
 * The FULL structured artifact is archived to observability
 * (POST /compactions); the prose + refs is what enters model context.
 */

import { PennyCompactArtifactSchema, SCHEMA_VERSION, type PennyCompactArtifact } from "./schema.js";
import type {
  MempalaceRoomRef,
  KGEntityRef,
  DecisionRef,
  EvictionRecord,
  CompactionReason,
  BoundaryShiftRecord,
} from "./schema.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { detectPendingState } from "./pending.js";
import {
  queryEngineRuns,
  queryMempalaceSkillRooms,
  queryMempalaceSkillRoomsForSession,
  queryKGEntitiesForSession,
  queryOutcomeLedgerDecisions,
  llmMergeGoal,
} from "./bridge.js";
import type { SessionMessage } from "./pi-messages.js";
import { asRecord, asString } from "./pi-messages.js";
import { createLogger, setSessionId } from "../../lib/logger/logger.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const logger = createLogger("compaction");

// ============================================================
// .env Fallback Loader
// Pi doesn't load .env files, but the Python observability server does
// (via python-dotenv). This creates an asymmetry where TS extensions
// can't authenticate to the server if the shell didn't export the key.
// We parse .env directly as a fallback.
// ============================================================

let _envCache: Record<string, string> | null = null;

function readDotEnv(): Record<string, string> {
  if (_envCache) return _envCache;
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const envPath = resolve(projectRoot, ".env");
  try {
    const content = readFileSync(envPath, "utf-8");
    const env: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    _envCache = env;
    return env;
  } catch {
    // .env not found or unreadable — return empty
    return {};
  }
}

function getEnvVar(key: string): string | undefined {
  // Prefer process.env (shell environment) first, fall back to .env file
  if (process.env[key] !== undefined && process.env[key] !== "") return process.env[key];
  return readDotEnv()[key];
}

// ============================================================
// Configuration
// ============================================================

const CONFIG = {
  schemaVersion: SCHEMA_VERSION,
  maxArtifactTokens: 6000,
  /** Consecutive byte-identical Goal count at which the canary logs. */
  goalStagnationThreshold: 3,
};

// ============================================================
// Skill Invocation Detection
// ============================================================

export interface SkillInvocation {
  skill_name: string;
  session_id: string;
  goal: string;
  completed: boolean;
  constraints?: Record<string, unknown>;
}

/**
 * Scan messages (newest first) for the most recent `skill` tool call.
 *
 * The session_id comes ONLY from the paired tool result — it is never
 * fabricated. A fabricated ID poisons session scoping downstream (it can
 * never match a real mempalace room or checkpointer row), so "empty" is
 * the honest value when the result carries none.
 */
export function detectDominantSkill(messages: SessionMessage[]): SkillInvocation | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type !== "toolCall" || block.name !== "skill" || !block.arguments) continue;

      const skillName =
        typeof block.arguments.skill_name === "string" ? block.arguments.skill_name : "";
      const goal = typeof block.arguments.goal === "string" ? block.arguments.goal : "";
      if (!skillName || !goal) continue;

      // Pair with THIS call's result: match by toolCallId when the call
      // has an id; otherwise take the first subsequent skill toolResult.
      let completed = false;
      let sessionId = "";
      for (let j = i + 1; j < messages.length; j++) {
        const resultMsg = messages[j];
        if (resultMsg.role !== "toolResult") continue;
        const matches = block.id
          ? resultMsg.toolCallId === block.id
          : resultMsg.toolName === "skill";
        if (matches) {
          const resultData = extractResultData(resultMsg);
          completed = resultData.success || false;
          sessionId = resultData.session_id || "";
          break;
        }
      }

      // Most recent invocation wins — stop scanning
      const rawConstraints = block.arguments.constraints;
      return {
        skill_name: skillName,
        session_id: sessionId,
        goal,
        completed,
        ...(rawConstraints && typeof rawConstraints === "object"
          ? { constraints: rawConstraints as Record<string, unknown> }
          : {}),
      };
    }
  }

  return null;
}

function extractResultData(resultMsg: SessionMessage): {
  success: boolean;
  session_id: string;
  summary: string;
} {
  const text = resultMsg.content?.toString() || "";
  try {
    const parsed = asRecord(JSON.parse(text));
    const planSummary = asRecord(parsed.plan_summary);
    const plan = asRecord(parsed.plan);
    return {
      success: Boolean(parsed.success),
      session_id: asString(parsed.session_id),
      summary: asString(planSummary.goal) || asString(plan.title),
    };
  } catch {
    return { success: false, session_id: "", summary: "" };
  }
}

// ============================================================
// Message Extraction
// ============================================================

interface ExtractedState {
  goal: string;
  constraints: string[];
  /** True when a COMPLETED skill's goal was displaced by a fresher user pivot. */
  superseded: boolean;
}

/** The minimum length for a user message to count as a substantive goal signal. */
const SUBSTANTIVE_MIN_LEN = 10;

/**
 * Find the chronologically LATEST substantive user message.
 *
 * `messages` is chronological, so we scan from the end (newest-first) and
 * return the first user-role message with real text. There is NO keyword or
 * phrase denylist: the only gate is a length floor (trivial acks like "ok"
 * are not intent). Removing the denylist is the core of the goal-recency
 * fix — the latest substantive intent wins, whatever words it uses.
 */
function newestSubstantiveUserMessage(
  messages: SessionMessage[]
): { text: string; index: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    const content = extractTextContent(msg);
    if (content && content.trim().length > SUBSTANTIVE_MIN_LEN) {
      return { text: content.trim(), index: i };
    }
  }
  return null;
}

/**
 * Index of the most recent `skill` tool call — matches detectDominantSkill's
 * selection (newest wins). Used to decide whether a user message is "later"
 * than the dominant skill (supersession).
 */
function latestSkillCallIndex(messages: SessionMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "toolCall" && block.name === "skill" && block.arguments) {
        const sn = typeof block.arguments.skill_name === "string" ? block.arguments.skill_name : "";
        const g = typeof block.arguments.goal === "string" ? block.arguments.goal : "";
        if (sn && g) return i;
      }
    }
  }
  return -1;
}

/**
 * Extract the session goal and explicit constraints, honoring the canonical
 * goal-selection precedence:
 *
 *   1. INCOMPLETE active skill goal
 *   2. engine-run goal
 *   3. newest substantive user message in the merged window
 *   4. previousSummary carry-forward (never overrides a fresh user pivot)
 *   5. system message
 *   6. default (caller supplies)
 *
 * Supersession: a COMPLETED skill does NOT set Goal when a substantive user
 * message follows it — that later pivot wins and `superseded` is returned so
 * the caller can flag `dominant_skill.superseded`. A completed skill with no
 * later user pivot still supplies the goal (best summary of the session).
 *
 * Constraints come ONLY from explicit sources (the skill call's constraints
 * object). Keyword-scraping free text for "must"/"prefer" produced noise
 * inside a hard token budget and was removed.
 */
export function extractSessionState(
  messages: SessionMessage[],
  dominantSkill?: SkillInvocation | null,
  engineRunGoal?: string,
  previousSummaryGoal?: string
): ExtractedState {
  let goal = "";
  let superseded = false;
  const constraints: string[] = [];

  const newestUser = newestSubstantiveUserMessage(messages);

  // Precedence #1 / supersession: the dominant skill.
  if (dominantSkill?.goal) {
    if (!dominantSkill.completed) {
      // Incomplete active skill wins outright.
      goal = dominantSkill.goal.slice(0, 500);
    } else {
      // Completed skill: a substantive user message AFTER the skill call is a
      // genuine pivot and supersedes the (done) skill goal.
      const skillIdx = latestSkillCallIndex(messages);
      if (newestUser && newestUser.index > skillIdx) {
        goal = newestUser.text.slice(0, 500);
        superseded = true;
      } else {
        goal = dominantSkill.goal.slice(0, 500);
      }
    }
  }

  if (dominantSkill?.constraints) {
    for (const [key, value] of Object.entries(dominantSkill.constraints)) {
      // Skip the resume-plumbing key — it's transport, not a user constraint
      if (key === "user_response") continue;
      const rendered = `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
      constraints.push(rendered.slice(0, 200));
      if (constraints.length >= 20) break;
    }
  }

  // Precedence #2: engine-run goal.
  if (!goal && engineRunGoal) {
    goal = engineRunGoal.slice(0, 500);
  }

  // Precedence #3: newest substantive user message.
  if (!goal && newestUser) {
    goal = newestUser.text.slice(0, 500);
  }

  // Precedence #4: carry forward the prior Goal. This only fires when the
  // current window yielded no fresher substantive signal, so a fresh user
  // pivot (handled above) always wins over carry-forward.
  if (!goal && previousSummaryGoal) {
    goal = previousSummaryGoal.slice(0, 500);
  }

  // Precedence #5: system message.
  if (!goal) {
    for (const msg of messages) {
      const content = extractTextContent(msg);
      if (content && msg.role === "system") {
        goal = content.slice(0, 500);
        break;
      }
    }
  }

  return { goal, constraints, superseded };
}

function extractTextContent(msg: SessionMessage): string | null {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join(" ");
  }
  return null;
}

// ============================================================
// previousSummary Goal Carry-Forward (Fix A) + Stagnation Canary
// ============================================================

/** Placeholder / non-goal strings that must never be carried forward. */
const NON_GOAL_TEXT = /^\(not set\)$|goal not yet extracted/i;

/**
 * Parse the `## Goal` section out of a prior prose summary (Fix A).
 *
 * Tolerant of heading depth and of summaries this extension did NOT author
 * (Pi's own default format, or a hand-edited brief): it looks for any
 * `#..###### Goal` heading and collects the following non-heading lines up to
 * the next heading / rule / blank gap. Returns null when there is no parseable
 * goal or the text is a known placeholder — the caller then falls through to
 * the next precedence tier rather than carrying junk forward.
 */
export function parseGoalFromSummary(summary: string | undefined): string | null {
  if (!summary) return null;
  const lines = summary.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^#{1,6}\s+Goal\s*$/i.test(lines[i].trim())) continue;
    const collected: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t === "") {
        if (collected.length > 0) break;
        continue;
      }
      if (/^#{1,6}\s/.test(t) || t === "---") break;
      collected.push(t);
    }
    const text = collected.join(" ").trim();
    if (!text || NON_GOAL_TEXT.test(text)) return null;
    return text.slice(0, 500);
  }
  return null;
}

/** Hidden marker carrying the goal-stagnation streak across compactions. */
const GOAL_STREAK_MARKER = /<!--\s*penny-goal-streak:(\d+)\s*-->/;

/** Read the streak count embedded by a prior compaction (0 when absent). */
export function parseGoalStreak(summary: string | undefined): number {
  if (!summary) return 0;
  const m = summary.match(GOAL_STREAK_MARKER);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Compute the running count of consecutive byte-identical goals. A change of
 * goal resets the streak to 1; an unchanged goal increments the prior streak.
 */
export function computeGoalStreak(
  currentGoal: string,
  previousGoal: string | null,
  previousStreak: number
): number {
  if (currentGoal && previousGoal && currentGoal === previousGoal) {
    return Math.max(1, previousStreak) + 1;
  }
  return 1;
}

/**
 * Observability regression canary: is the goal byte-identical across enough
 * consecutive compactions to look stuck? This is LOG-ONLY — it never alters
 * goal selection, because a long single-task session legitimately keeps the
 * same goal.
 */
export function goalStagnationCanary(
  streak: number,
  threshold: number = CONFIG.goalStagnationThreshold
): boolean {
  return streak >= threshold;
}

/** Append the streak marker as an invisible HTML comment (renders to nothing). */
function appendGoalStreakMarker(summary: string, streak: number): string {
  if (streak <= 0) return summary;
  return `${summary}\n<!-- penny-goal-streak:${streak} -->`;
}

// ============================================================
// Work Context Derivation (## Current Work / ## Next Steps)
// ============================================================

interface WorkContextInput {
  dominantSkill?: SkillInvocation | null;
  engineRuns: PennyCompactArtifact["engine_runs"];
  pending: PennyCompactArtifact["pending"];
  goal: string;
  customInstructions?: string;
}

/**
 * Derive a short "what is happening right now" line and the concrete next
 * steps, from live signal only. Returns undefined fields when no signal
 * exists so the renderer omits the sections entirely (no filler).
 *
 * `customInstructions` (the C8 sink) is threaded in as the first, highest
 * priority next step — it is the user's explicit focus hint for THIS
 * compaction.
 */
export function deriveWorkContext(input: WorkContextInput): {
  current_work?: string;
  next_steps?: string[];
} {
  let current_work: string | undefined;

  if (input.dominantSkill && !input.dominantSkill.completed) {
    current_work =
      `Running skill "${input.dominantSkill.skill_name}" — ${input.dominantSkill.goal}`.slice(
        0,
        1000
      );
  } else if (input.engineRuns.length > 0) {
    const r = input.engineRuns[0];
    current_work =
      `${r.playbook} run ${r.run_id} is ${r.status} in state ${r.current_state_id}`.slice(0, 1000);
  } else if (input.pending) {
    current_work = `Handling ${input.pending.state}: ${input.pending.question_summary}`.slice(
      0,
      1000
    );
  }

  const next_steps: string[] = [];
  const focus = input.customInstructions?.trim();
  if (focus) {
    next_steps.push(`Focus (from /compact): ${focus}`.slice(0, 300));
  }
  for (const r of input.engineRuns) {
    if (r.status === "awaiting_user" && r.clarification_text) {
      next_steps.push(`Answer run ${r.run_id}: ${r.clarification_text}`.slice(0, 300));
    }
  }
  if (input.pending?.question_summary) {
    next_steps.push(
      `Resolve ${input.pending.state}: ${input.pending.question_summary}`.slice(0, 300)
    );
  }

  return {
    ...(current_work ? { current_work } : {}),
    ...(next_steps.length > 0 ? { next_steps: next_steps.slice(0, 10) } : {}),
  };
}

// ============================================================
// Tool Call Pattern Extraction (for weak tool-callers)
// ============================================================

interface ToolCallExample {
  tool: string;
  params: Record<string, unknown>;
  successful: boolean;
}

interface ToolErrorRecovery {
  tool: string;
  failed_params: Record<string, unknown>;
  error_message: string;
  corrected_params: Record<string, unknown>;
}

/**
 * Conservative error detection for Pi tool result messages.
 *
 * The explicit `isError` flag is authoritative in BOTH directions: a
 * result with isError === false is a success even if its content mentions
 * errors (grepping a log for "error" is not a failed tool call). Content
 * heuristics apply only when the flag is absent, and only match shapes
 * that look like an error REPORT, not error-shaped data.
 */
export function isToolResultError(msg: SessionMessage | undefined): boolean {
  if (!msg || msg.role !== "toolResult") return false;
  if (typeof msg.isError === "boolean") return msg.isError;
  const text = msg.content?.toString().trim() || "";
  return /^(error|tool_use_error|validation failed|traceback)/i.test(text);
}

/**
 * Extract recent tool call examples from assistant messages.
 * Keeps the last N calls (with verbatim params) to serve as in-context
 * schema examples for models that learn tool usage from history.
 */
export function extractToolCalls(
  messages: SessionMessage[],
  maxCalls: number = 15
): ToolCallExample[] {
  const examples: ToolCallExample[] = [];

  for (let i = messages.length - 1; i >= 0 && examples.length < maxCalls; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type === "toolCall" && block.arguments) {
        const nextMsg = messages[i + 1];
        const isSuccess = nextMsg?.role === "toolResult" && !isToolResultError(nextMsg);

        examples.push({
          tool: block.name ?? "",
          params: block.arguments,
          successful: isSuccess,
        });
        if (examples.length >= maxCalls) break;
      }
    }
  }

  return examples.reverse(); // chronological order
}

/**
 * Extract error → correction pairs from recent tool call failures.
 * Captures failed attempts and their successful retries to teach the
 * model what NOT to do.
 */
export function extractToolErrorRecovery(
  messages: SessionMessage[],
  maxPairs: number = 3
): ToolErrorRecovery[] {
  const pairs: ToolErrorRecovery[] = [];

  for (let i = 0; i < messages.length && pairs.length < maxPairs; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type !== "toolCall" || !block.arguments) continue;

      const nextMsg = messages[i + 1];
      if (!isToolResultError(nextMsg)) {
        continue;
      }

      // Find the retry (next assistant message with same tool)
      let foundRetry = false;
      for (let j = i + 2; j < messages.length && !foundRetry; j++) {
        const retryMsg = messages[j];
        if (retryMsg.role !== "assistant" || !Array.isArray(retryMsg.content)) continue;

        for (const retryBlock of retryMsg.content) {
          if (retryBlock.type === "toolCall" && retryBlock.name === block.name) {
            pairs.push({
              tool: block.name ?? "",
              failed_params: block.arguments,
              error_message: nextMsg?.content?.toString().slice(0, 200) || "Unknown error",
              corrected_params: retryBlock.arguments ?? {},
            });
            foundRetry = true;
            break;
          }
        }
      }
    }
  }

  return pairs;
}

// ============================================================
// Recency-Weighted Eviction Algorithm
// ============================================================

function recencyBand(lastUpdated: string): number {
  const ageMs = Date.now() - new Date(lastUpdated).getTime();
  if (ageMs <= 3_600_000) return 3; // ≤ 1 hour
  if (ageMs <= 86_400_000) return 2; // ≤ 24 hours
  if (ageMs <= 604_800_000) return 1; // ≤ 7 days
  return 0; // older
}

interface EvictableItem<T> {
  value: T;
  priority: number;
  confidenceOrdinal: number;
  recencyBand: number;
  timestamp: number;
}

function evictionPriority<T>(
  field: string,
  item: T,
  isError: boolean = false,
  protectedSessionIds: string[] = []
): EvictableItem<T> {
  let priority = 7;
  let confidenceOrdinal = 2;
  let ts = Date.now();

  const rec = asRecord(item);
  const room = asString(rec.room);
  const lastUpdated = asString(rec.last_updated);

  // Rooms belonging to a live session are NEVER evicted. protectedSessionIds
  // are real IDs (skill results / checkpointer rows), so includes() matches.
  if (field === "mempalace_rooms" && room) {
    const roomText = room.toLowerCase();
    if (protectedSessionIds.some((id) => id && roomText.includes(id.toLowerCase()))) {
      return { value: item, priority: 0, confidenceOrdinal: 5, recencyBand: 3, timestamp: ts };
    }
  }

  if (isError && rec.resolved === false) {
    priority = 1;
  } else if (field === "decisions") {
    switch (rec.confidence) {
      case "CERTAIN":
        priority = 3;
        confidenceOrdinal = 4;
        break;
      case "PROBABLE":
        priority = 4;
        confidenceOrdinal = 3;
        break;
      case "POSSIBLE":
        priority = 5;
        confidenceOrdinal = 2;
        break;
      case "UNCERTAIN":
        priority = 6;
        confidenceOrdinal = 1;
        break;
    }
  } else if (field === "kg_entities") {
    priority = 9;
  } else if (field === "metadata.pi_boundary") {
    priority = 10;
  }

  // Extract timestamp from item
  if (lastUpdated) {
    try {
      ts = new Date(lastUpdated).getTime();
    } catch {
      /* use now */
    }
  }

  const recency = recencyBand(lastUpdated || new Date().toISOString());

  return { value: item, priority, confidenceOrdinal, recencyBand: recency, timestamp: ts };
}

export function evictArray<T>(
  field: string,
  items: T[],
  maxCount: number,
  isError: boolean = false,
  protectedSessionIds: string[] = []
): { kept: T[]; evicted: number; log: EvictionRecord[] } {
  if (items.length <= maxCount) {
    return { kept: items, evicted: 0, log: [] };
  }

  const scored = items.map((item) => evictionPriority(field, item, isError, protectedSessionIds));
  scored.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.recencyBand !== b.recencyBand) return b.recencyBand - a.recencyBand;
    if (a.confidenceOrdinal !== b.confidenceOrdinal)
      return b.confidenceOrdinal - a.confidenceOrdinal;
    return a.timestamp - b.timestamp;
  });

  const kept = scored.slice(0, maxCount).map((s) => s.value);
  const evicted = scored.length - maxCount;

  const log: EvictionRecord[] =
    evicted > 0
      ? [
          {
            field,
            evicted_count: evicted,
            strategy: "priority_recency_confidence_age",
            timestamp: new Date().toISOString(),
          },
        ]
      : [];

  return { kept, evicted, log };
}

/**
 * Enforce cardinality caps on the artifact. `scale` (0 < scale ≤ 1)
 * tightens every cap proportionally — the degrade path when the summary
 * overflows the token budget. Never returns an empty artifact: every cap
 * has a floor of 1, and the eviction priority keeps the most valuable
 * item in each field.
 */
export function applyEviction(
  artifact: PennyCompactArtifact,
  protectedSessionIds: string[] = [],
  scale: number = 1
): PennyCompactArtifact {
  const evictionLog: EvictionRecord[] = [];
  const cap = (n: number) => Math.max(1, Math.floor(n * scale));

  const apply = <T>(field: string, items: T[], max: number, isErr = false): T[] => {
    if (items.length > max) {
      const r = evictArray(field, items, max, isErr, protectedSessionIds);
      evictionLog.push(...r.log);
      return r.kept;
    }
    return items;
  };

  artifact.constraints = apply("constraints", artifact.constraints, cap(20));
  artifact.preferences = apply("preferences", artifact.preferences, cap(10));
  artifact.decisions = apply("decisions", artifact.decisions, cap(20));
  artifact.errors = apply("errors", artifact.errors, cap(10), true);
  artifact.engine_runs = apply("engine_runs", artifact.engine_runs, cap(5));
  artifact.mempalace_rooms = apply("mempalace_rooms", artifact.mempalace_rooms, cap(10));
  artifact.kg_entities = apply("kg_entities", artifact.kg_entities, cap(20));
  artifact.files.read = apply("files.read", artifact.files.read, cap(30));
  artifact.files.modified = apply("files.modified", artifact.files.modified, cap(30));
  artifact.tool_calls = apply("tool_calls", artifact.tool_calls, cap(15));
  artifact.tool_error_recovery = apply(
    "tool_error_recovery",
    artifact.tool_error_recovery,
    Math.max(1, Math.floor(3 * scale)),
    true
  );

  artifact.metadata.eviction_log = [...artifact.metadata.eviction_log, ...evictionLog].slice(0, 10);

  return artifact;
}

// ============================================================
// Prose Summary + RESUME-REFS Builder
// ============================================================

function compactJson(value: unknown, maxLen: number): string {
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

function isRealDrawerId(id: string | undefined): boolean {
  return Boolean(id && id !== "unknown" && !id.startsWith("pending-"));
}

/**
 * The pointer appendix. Every line is a REAL, dereferenceable address —
 * placeholder IDs are skipped rather than rendered, because a fake
 * pointer is worse than no pointer. Post-compaction Penny resumes runs
 * with skill(skill_name=<playbook>, goal=..., resumeFrom=<session_id>)
 * and reads rooms/drawers/entities with her memory tools.
 */
export function buildResumeRefs(artifact: PennyCompactArtifact): string {
  const lines: string[] = [];

  for (const run of artifact.engine_runs) {
    lines.push(
      `run: run_id=${run.run_id} playbook=${run.playbook} state=${run.current_state_id} ` +
        `status=${run.status} resume=skill(skill_name="${run.playbook}", resumeFrom="${run.session_id}")`
    );
    if (run.clarification_text) {
      lines.push(`  awaiting-user: ${run.clarification_text}`);
    }
  }

  for (const r of artifact.mempalace_rooms) {
    const drawers = (r.drawer_ids || []).filter(isRealDrawerId);
    const marker = r.dominant_for_session ? " (active session)" : "";
    lines.push(
      `room: ${r.wing}/${r.room}${drawers.length ? ` drawers=${drawers.join(",")}` : ""}${marker}`
    );
  }

  for (const d of artifact.decisions) {
    lines.push(`decision: ${d.decision_id} (${d.confidence}) ${d.summary.slice(0, 80)}`);
  }

  for (const e of artifact.kg_entities) {
    lines.push(`kg: ${e.entity_id} [${e.relevant_predicates.join(", ")}]`);
  }

  if (artifact.pending && isRealDrawerId(artifact.pending.mempalace_drawer_id)) {
    lines.push(`pending-drawer: ${artifact.pending.mempalace_drawer_id}`);
  }

  // Verbatim tool examples: successful calls (one per tool) teach the
  // schema; error→correction pairs teach what NOT to do.
  const seenTools = new Set<string>();
  let exampleCount = 0;
  for (const t of artifact.tool_calls) {
    if (!t.successful || seenTools.has(t.tool) || exampleCount >= 6) continue;
    seenTools.add(t.tool);
    exampleCount++;
    lines.push(`tool-ok: ${t.tool} ${compactJson(t.params, 140)}`);
  }
  for (const rec of artifact.tool_error_recovery) {
    lines.push(
      `tool-fix: ${rec.tool} failed=${compactJson(rec.failed_params, 100)} ` +
        `error="${rec.error_message.slice(0, 80)}" fixed=${compactJson(rec.corrected_params, 100)}`
    );
  }

  if (lines.length === 0) return "";
  return ["[RESUME-REFS v2]", ...lines, "[/RESUME-REFS]"].join("\n");
}

/**
 * Convert a PennyCompactArtifact to the summary spliced into context:
 * a prose markdown brief (Pi-native style, human-readable in the TUI)
 * followed by the [RESUME-REFS] pointer appendix.
 */
export function createProseSummary(artifact: PennyCompactArtifact): string {
  const lines: string[] = [];

  // Goal
  lines.push(`## Goal`);
  lines.push(artifact.goal || "(not set)");
  lines.push("");

  // Dominant skill
  if (artifact.dominant_skill) {
    const ds = artifact.dominant_skill;
    const status = ds.completed ? "complete" : "incomplete";
    const supersededTag = ds.superseded ? ", superseded by a newer request" : "";
    lines.push(`## Active Skill`);
    lines.push(`- **${ds.skill_name}** (${status}${supersededTag})`);
    if (ds.goal && ds.goal !== artifact.goal) {
      lines.push(`- Skill goal: ${ds.goal}`);
    }
    lines.push("");
  }

  // Current work — rendered only when derivable (no filler).
  if (artifact.current_work) {
    lines.push(`## Current Work`);
    lines.push(artifact.current_work);
    lines.push("");
  }

  // In-flight engine runs (checkpointer truth)
  if (artifact.engine_runs.length > 0) {
    lines.push(`## In-Flight Orchestration Runs`);
    for (const run of artifact.engine_runs) {
      lines.push(
        `- **${run.playbook}** run \`${run.run_id}\` is ${run.status} in state ` +
          `**${run.current_state_id}**${run.goal ? ` — ${run.goal.slice(0, 120)}` : ""}`
      );
      if (run.status === "awaiting_user" && run.clarification_text) {
        lines.push(`  - Waiting on the user: ${run.clarification_text}`);
      }
    }
    lines.push("");
  }

  // Pending
  if (artifact.pending) {
    lines.push(`## Pending`);
    lines.push(`- State: **${artifact.pending.state}**`);
    if (artifact.pending.question_summary) {
      lines.push(`- Reason: ${artifact.pending.question_summary}`);
    }
    lines.push("");
  }

  // Next steps — rendered only when derivable (no filler).
  if (artifact.next_steps && artifact.next_steps.length > 0) {
    lines.push(`## Next Steps`);
    for (const step of artifact.next_steps.slice(0, 10)) {
      lines.push(`- ${step}`);
    }
    lines.push("");
  }

  // Constraints
  if (artifact.constraints.length > 0) {
    lines.push(`## Constraints`);
    for (const c of artifact.constraints.slice(0, 5)) {
      lines.push(`- ${c}`);
    }
    lines.push("");
  }

  // Preferences
  if (artifact.preferences.length > 0) {
    lines.push(`## Preferences`);
    for (const p of artifact.preferences.slice(0, 5)) {
      lines.push(`- ${p}`);
    }
    lines.push("");
  }

  // Decisions
  if (artifact.decisions.length > 0) {
    lines.push(`## Key Decisions`);
    for (const d of artifact.decisions.slice(0, 5)) {
      lines.push(`- **${d.confidence}**: ${d.summary} (${d.outcome_room})`);
    }
    lines.push("");
  }

  // Errors
  const unresolved = artifact.errors.filter((e) => !e.resolved);
  if (unresolved.length > 0) {
    lines.push(`## Unresolved Errors`);
    for (const e of unresolved.slice(0, 3)) {
      lines.push(`- ${e.error_type}: ${e.message}`);
    }
    lines.push("");
  }

  // Files
  const read = artifact.files.read;
  const modified = artifact.files.modified;
  if (read.length > 0 || modified.length > 0) {
    lines.push(`## Files`);
    if (read.length > 0) {
      lines.push(`### Read`);
      for (const f of read.slice(0, 10)) {
        lines.push(`- ${f}`);
      }
    }
    if (modified.length > 0) {
      lines.push(`### Modified`);
      for (const f of modified.slice(0, 10)) {
        lines.push(`- ${f}`);
      }
    }
    lines.push("");
  }

  const refs = buildResumeRefs(artifact);
  if (refs) {
    lines.push("---");
    lines.push(refs);
  }

  return lines.join("\n").trim();
}

// ============================================================
// Artifact Builder
// ============================================================

interface BuildArtifactInput {
  sessionId: string;
  compactionSeq: number;
  /** Chronological, already-merged [messagesToSummarize, ...turnPrefixMessages]. */
  messages: SessionMessage[];
  preparation: {
    firstKeptEntryId: string;
    tokensBefore: number;
    fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> };
    previousSummary?: string;
  };
  /** What triggered this compaction (Pi event.reason). Sink + Next Steps, no code fork. */
  reason?: CompactionReason;
  /** The user's focus hint (Pi event.customInstructions). Sink + Next Steps + Fix B. */
  customInstructions?: string;
  /** previous/current firstKeptEntryId shift, computed from branchEntries. */
  boundaryShift?: BoundaryShiftRecord;
  /** The compaction event's abort signal, forwarded to Fix B. */
  signal?: AbortSignal;
}

async function buildArtifact(
  input: BuildArtifactInput
): Promise<{ artifact: PennyCompactArtifact; protectedSessionIds: string[] }> {
  const now = new Date().toISOString();
  const seq = input.compactionSeq;

  const readFiles = Array.from(input.preparation.fileOps.read);
  const modifiedFiles = [
    ...Array.from(input.preparation.fileOps.written),
    ...Array.from(input.preparation.fileOps.edited),
  ];

  // Step 1: dominant skill from the message log (sync).
  const dominant = detectDominantSkill(input.messages);

  // Step 2: in-flight runs from the engine checkpointer — needed first
  // because their session_ids drive mempalace scoping.
  let engineRuns: PennyCompactArtifact["engine_runs"] = [];
  try {
    engineRuns = await queryEngineRuns();
  } catch (err) {
    logger.error(
      "Engine checkpointer query failed during compaction",
      { error: err instanceof Error ? err.message : String(err) },
      Object.assign(new Error("Engine checkpointer query failed"), {
        code: "COMPACTION_ENGINE_QUERY_FAILED",
      })
    );
  }

  // Real session IDs only: skill results + checkpointer rows.
  const protectedSessionIds = [
    ...(dominant?.session_id ? [dominant.session_id] : []),
    ...engineRuns.map((r) => r.session_id),
  ];

  // Step 3: everything else is independent — query in parallel.
  const [pending, mempalaceRooms, kgEntities, decisions] = await Promise.all([
    detectPendingState(input.messages, input.sessionId).catch((err) => {
      logger.warn("Pending state detection failed", { error: String(err) });
      return null;
    }),
    (protectedSessionIds.length > 0
      ? queryMempalaceSkillRoomsForSession(protectedSessionIds)
      : queryMempalaceSkillRooms()
    ).catch((err) => {
      logger.error(
        "Mempalace query failed during compaction",
        { error: err instanceof Error ? err.message : String(err) },
        Object.assign(new Error("Mempalace query failed"), {
          code: "COMPACTION_MEMPALACE_QUERY_FAILED",
        })
      );
      return [] as MempalaceRoomRef[];
    }),
    queryKGEntitiesForSession(input.sessionId).catch((err) => {
      logger.error(
        "KG query failed during compaction",
        { error: err instanceof Error ? err.message : String(err) },
        Object.assign(new Error("KG query failed"), { code: "COMPACTION_KG_QUERY_FAILED" })
      );
      return [] as KGEntityRef[];
    }),
    queryOutcomeLedgerDecisions(20).catch((err) => {
      logger.error(
        "Outcome ledger query failed during compaction",
        { error: err instanceof Error ? err.message : String(err) },
        Object.assign(new Error("Outcome ledger query failed"), {
          code: "COMPACTION_OUTCOME_QUERY_FAILED",
        })
      );
      return [] as DecisionRef[];
    }),
  ]);

  // Fix A: carry the prior Goal forward when the current window yields no
  // fresher substantive signal. Parsed defensively from the prior summary
  // (may be Pi's own format or hand-edited) — null when unparseable.
  const previousSummaryGoal = parseGoalFromSummary(input.preparation.previousSummary);

  const extracted = extractSessionState(
    input.messages,
    dominant,
    engineRuns[0]?.goal,
    previousSummaryGoal ?? undefined
  );

  let goal = extracted.goal || "Active session - goal not yet extracted";

  // Fix B (P1, config-gated, OFF by default): an LLM-assisted merge of the
  // previous summary with the deterministic candidate goal. Returns null when
  // disabled/misconfigured or on any timeout/abort/error, so Fix A always
  // remains the authoritative fallback — the summary is never abandoned.
  if (input.preparation.previousSummary) {
    try {
      const merged = await llmMergeGoal({
        previousSummary: input.preparation.previousSummary,
        candidateGoal: goal,
        customInstructions: input.customInstructions,
        signal: input.signal,
      });
      if (merged) goal = merged;
    } catch (err) {
      logger.warn("Fix B merge threw; using Fix A goal", { error: String(err) });
    }
  }

  // Goal-stagnation canary (P2, observational only — never alters the goal).
  const previousStreak = parseGoalStreak(input.preparation.previousSummary);
  const goalStreak = computeGoalStreak(goal, previousSummaryGoal, previousStreak);
  if (goalStagnationCanary(goalStreak)) {
    logger.warn("Goal unchanged across consecutive compactions (stagnation canary)", {
      goal: goal.slice(0, 120),
      streak: goalStreak,
      session_id: input.sessionId,
    });
  }

  const work = deriveWorkContext({
    dominantSkill: dominant,
    engineRuns,
    pending,
    goal,
    customInstructions: input.customInstructions,
  });

  let artifact: PennyCompactArtifact = {
    schema_version: CONFIG.schemaVersion,
    session_id: input.sessionId,
    compaction_seq: seq,
    compaction_timestamp: now,

    goal,
    constraints: extracted.constraints,
    preferences: [],
    pending,
    ...(work.current_work ? { current_work: work.current_work } : {}),
    ...(work.next_steps ? { next_steps: work.next_steps } : {}),

    dominant_skill: dominant
      ? {
          skill_name: dominant.skill_name,
          session_id: dominant.session_id || "unknown",
          goal: dominant.goal,
          completed: dominant.completed,
          // Only flag supersession for a completed skill displaced by a pivot.
          ...(extracted.superseded ? { superseded: true } : {}),
        }
      : undefined,

    decisions,
    errors: [],

    engine_runs: engineRuns,

    mempalace_rooms: mempalaceRooms,
    kg_entities: kgEntities,
    files: {
      read: readFiles,
      modified: modifiedFiles,
    },

    tool_calls: extractToolCalls(input.messages),
    tool_error_recovery: extractToolErrorRecovery(input.messages),

    metadata: {
      eviction_log: [],
      pi_boundary: {
        first_kept_entry_id: input.preparation.firstKeptEntryId,
        tokens_before: input.preparation.tokensBefore,
        // Populated on every compaction after a session's first (seq >= 1).
        ...(input.boundaryShift ? { boundary_shift: input.boundaryShift } : {}),
      },
      // C8 named sink: additive, optional, threaded without a reason code fork.
      ...(input.reason ? { compaction_reason: input.reason } : {}),
      ...(input.customInstructions ? { custom_instructions: input.customInstructions } : {}),
      goal_streak: goalStreak,
    },
  };

  artifact = applyEviction(artifact, protectedSessionIds);

  return { artifact, protectedSessionIds };
}

// ============================================================
// Validation
// ============================================================

function validateArtifact(artifact: unknown): { valid: boolean; errors: string[] } {
  const result = PennyCompactArtifactSchema.safeParse(artifact);
  if (result.success) {
    return { valid: true, errors: [] };
  }
  const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
  return { valid: false, errors };
}

// ============================================================
// Token Estimation (tiktoken; chars/4 heuristic fallback)
// ============================================================

interface TokenEncoder {
  encode(text: string): ArrayLike<number>;
}

let tiktokenEncoder: TokenEncoder | null = null;

function getEncoder(): TokenEncoder | null {
  if (!tiktokenEncoder) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const tiktoken = require("tiktoken");
      tiktokenEncoder = tiktoken.encoding_for_model("gpt-4o");
    } catch {
      return null;
    }
  }
  return tiktokenEncoder;
}

function estimateTokens(text: string): number {
  const enc = getEncoder();
  if (enc) {
    return enc.encode(text).length;
  }
  return Math.ceil(text.length / 4);
}

// ============================================================
// Observability Integration - POST compaction artifact
// ============================================================

interface ObservabilityPostConfig {
  baseUrl: string;
  apiKey: string;
}

let observabilityConfig: ObservabilityPostConfig;

/**
 * POST compaction artifact to the observability REST API.
 * Throws on failure so the caller can decide visibility.
 */
async function postCompactionArtifact(
  artifact: PennyCompactArtifact,
  firstKeptEntryId: string,
  tokensBefore: number
) {
  const url = `${observabilityConfig.baseUrl}/compactions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (observabilityConfig.apiKey) {
    headers["Authorization"] = `Bearer ${observabilityConfig.apiKey}`;
  }

  const body = {
    session_id: artifact.session_id,
    compaction_seq: artifact.compaction_seq,
    compaction_timestamp: artifact.compaction_timestamp,
    artifact,
    first_kept_entry_id: firstKeptEntryId,
    tokens_before: tokensBefore,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  clearTimeout(timeoutId);

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw Object.assign(new Error(`POST ${resp.status}: ${text.slice(0, 200)}`), {
      code: "COMPACTION_POST_FAILED",
    });
  }
}

// ============================================================
// Main Extension
// ============================================================

/**
 * Emit a structured error to the observability server.
 * Use this when compaction encounters a failure that needs recording.
 */
function failLoudly(
  message: string,
  context?: Record<string, unknown>,
  error?: Error & { code?: string }
): void {
  logger.error(message, context, error as Error & { code?: string });
}

/**
 * The `preparation` payload Pi hands to the session_before_compact hook.
 * Mirrors the installed pi-coding-agent CompactionPreparation shape; every
 * field this hook reads is captured here (the SDK types the boundary loosely).
 */
interface CompactionPreparation {
  firstKeptEntryId: string;
  tokensBefore: number;
  fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> };
  previousSummary?: string;
  /** Messages that will be summarized and discarded (older window). */
  messagesToSummarize?: SessionMessage[];
  /** Messages that become the turn-prefix summary when a turn is split (newer). */
  turnPrefixMessages?: SessionMessage[];
  /** True when the cut point falls mid-turn. */
  isSplitTurn?: boolean;
}

/**
 * A branch entry in the session log (only the fields this hook reads). Prior
 * compaction entries carry `firstKeptEntryId`, which is the source for
 * boundary_shift.previous.
 */
interface CompactionEntry {
  type?: string;
  sessionId?: string;
  firstKeptEntryId?: string;
}

interface SessionBeforeCompactEvent {
  preparation: CompactionPreparation;
  branchEntries: CompactionEntry[];
  /** What triggered the compaction: manual /compact, threshold, or overflow. */
  reason?: CompactionReason;
  /** The user's focus hint (e.g. `/compact <focus>`). */
  customInstructions?: string;
  /** True when the aborted turn is retried after this compaction. */
  willRetry?: boolean;
  /** Abort signal for the compaction; forwarded to Fix B. */
  signal?: AbortSignal;
}

/**
 * Merge the two message windows into one chronological array:
 * [older messagesToSummarize, ...newer turnPrefixMessages]. Every
 * message-derived extraction path (goal, dominant-skill, pending, tool-call,
 * tool-error-recovery) reads this merged view so a split-turn window whose
 * discarded messages live only in turnPrefixMessages is not dropped.
 */
function mergeCompactionMessages(preparation: CompactionPreparation): SessionMessage[] {
  return [...(preparation.messagesToSummarize || []), ...(preparation.turnPrefixMessages || [])];
}

/**
 * Compute the boundary shift from the previous compaction to this one, sourced
 * from branchEntries. Returns undefined on a session's first compaction (no
 * prior compaction entry exists).
 */
function computeBoundaryShift(
  branchEntries: CompactionEntry[],
  currentFirstKeptEntryId: string,
  compactionSeq: number
): BoundaryShiftRecord | undefined {
  if (compactionSeq < 1) return undefined;
  // The most recent prior compaction entry (branchEntries is chronological).
  let prev: string | undefined;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const e = branchEntries[i];
    if (e.type === "compaction" && e.firstKeptEntryId) {
      prev = e.firstKeptEntryId;
      break;
    }
  }
  if (!prev) return undefined;
  return { previous: prev, current: currentFirstKeptEntryId, compaction_seq: compactionSeq };
}

export default function compactionExtension(pi: ExtensionAPI) {
  observabilityConfig = {
    baseUrl: getEnvVar("PI_OBSERVABILITY_REST_URL") || "http://localhost:8765",
    apiKey: getEnvVar("PI_OBSERVABILITY_API_KEY") || "",
  };

  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent) => {
    const { preparation, branchEntries } = event;
    const sessionId =
      branchEntries.length > 0 && branchEntries[0].sessionId
        ? branchEntries[0].sessionId
        : "unknown";
    setSessionId(sessionId);

    // Compute compaction sequence by counting prior compactions in branch
    const compactionSeq = branchEntries.filter((e) => e.type === "compaction").length;

    // Merge both message windows so split-turn context is never dropped.
    const messages = mergeCompactionMessages(preparation);

    // boundary_shift is populated on every compaction after the first.
    const boundaryShift = computeBoundaryShift(
      branchEntries,
      preparation.firstKeptEntryId,
      compactionSeq
    );

    const build = await buildArtifact({
      sessionId,
      compactionSeq,
      messages,
      preparation: {
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        fileOps: preparation.fileOps,
        previousSummary: preparation.previousSummary,
      },
      reason: event.reason,
      customInstructions: event.customInstructions,
      boundaryShift,
      signal: event.signal,
    });
    let artifact = build.artifact;
    const protectedSessionIds = build.protectedSessionIds;

    // Validation failure is loud but NOT fatal: the prose summary is still
    // our best checkpoint — falling back to Pi's default prose would lose
    // strictly more. The invalid artifact is still archived for debugging.
    const validation = validateArtifact(artifact);
    if (!validation.valid) {
      failLoudly(
        "Compaction artifact validation failed (summary still emitted)",
        { errors: validation.errors },
        Object.assign(new Error(validation.errors.join("; ")), {
          code: "COMPACTION_VALIDATION_FAILED",
        })
      );
    }

    // Degrade, never abandon: on budget overflow, tighten every cardinality
    // cap and rebuild until the summary fits (or we hit the floor).
    let proseSummary = createProseSummary(artifact);
    let summaryTokens = estimateTokens(proseSummary);
    let scale = 1;
    while (summaryTokens > CONFIG.maxArtifactTokens && scale > 0.15) {
      scale /= 2;
      artifact = applyEviction(artifact, protectedSessionIds, scale);
      proseSummary = createProseSummary(artifact);
      summaryTokens = estimateTokens(proseSummary);
    }
    if (summaryTokens > CONFIG.maxArtifactTokens) {
      // Floor reached and still over budget — hard-truncate as the last
      // resort. Truncation cuts from the end (file lists / tool examples);
      // the goal, runs, and pending state at the top always survive.
      failLoudly(
        "Compaction summary truncated to fit budget",
        { budget: CONFIG.maxArtifactTokens, actual: summaryTokens },
        Object.assign(new Error(`Token budget ${summaryTokens} > ${CONFIG.maxArtifactTokens}`), {
          code: "COMPACTION_BUDGET_OVERFLOW",
        })
      );
      proseSummary =
        proseSummary.slice(0, CONFIG.maxArtifactTokens * 4) +
        "\n\n[summary truncated to fit compaction budget]";
    }

    // Fire-and-forget: send FULL artifact to observability backend.
    // On the SUCCESS path this is completely silent — no console noise.
    postCompactionArtifact(artifact, preparation.firstKeptEntryId, preparation.tokensBefore).then(
      () => {},
      (postErr) => {
        failLoudly(
          "Compaction artifact post to observability failed",
          { error: String(postErr) },
          Object.assign(new Error("POST /compactions failed"), {
            code: "COMPACTION_POST_FAILED",
          })
        );
      }
    );

    // Carry the goal-stagnation streak forward as an invisible marker so the
    // next compaction can compute "N consecutive identical goals" without
    // reading the observability archive. Renders to nothing in the TUI.
    proseSummary = appendGoalStreakMarker(proseSummary, artifact.metadata.goal_streak ?? 0);

    return {
      compaction: {
        summary: proseSummary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: artifact,
      },
    };
  });
}
