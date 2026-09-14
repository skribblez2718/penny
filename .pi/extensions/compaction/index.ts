/**
 * Penny Custom Compaction Extension
 *
 * Goal: when Pi compacts, Penny resumes with no work lost. The summary
 * spliced into context has two parts:
 *
 *   1. A prose brief — goal, in-flight runs, pending state —
 *      so Penny re-orients by reading, not parsing.
 *   2. A versioned [RESUME-REFS] appendix — exact run IDs and immutable
 *      artifact ID/digest pairs proven by current-session results, explicit reused
 *      inputs, prior exact indexes, or named orchestration checkpoints.
 *
 * Orchestration state is read only by exact run ID from the durable SQLite
 * checkpointer. Compaction never searches session rooms, durable memory, or a
 * semantic "active run" index, and recovery never depends on memory service
 * availability.
 *
 * Failure policy: degrade, never abandon. The shared result budget fits prose
 * at UTF-8 boundaries and removes refs only as complete lines; validation
 * failures log loudly while the prose summary is still emitted.
 *
 * The FULL structured artifact is archived to observability
 * (POST /compactions); the prose + refs is what enters model context.
 */

import {
  ArtifactRefSchema,
  PennyCompactArtifactSchema,
  RESUME_REFS_VERSION,
  ResumeRefSetSchema,
  SCHEMA_VERSION,
  type PennyCompactArtifact,
} from "./schema.js";
import type {
  ArtifactRef,
  ErrorRef,
  EvictionRecord,
  CompactionReason,
  BoundaryShiftRecord,
  ResumeRef,
  SkillResultStatus,
} from "./schema.js";
import { detectPendingState } from "./pending.js";
import {
  collectValidatedSkillResultNodes,
  parseSkillResultDetails,
  type ParsedSkillResultDetails,
} from "./skill-results.js";
import { readExactCheckpoints } from "./checkpointer.js";
import { generateModelSummary, renderGroundedDigest, type SummarizerCtx } from "./summarizer.js";
import { loanEnabled } from "./loans.js";
import type { SessionMessage } from "./pi-messages.js";
import { asArray, asRecord, asString, isRecord } from "./pi-messages.js";
import { createLogger, setSessionId } from "../../lib/logger/logger.js";
import {
  DEFAULT_TOOL_RESULT_BUDGET,
  ToolResultBudgetConfigError,
  assessReleaseHeadroom,
  createTextToolResult,
  fitUtf8ToolResult,
  measureToolResult,
  resolveToolResultBudget,
  type ToolResultBudget,
} from "../lib/tool-result-budget.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ArtifactStore,
  CATALOG_WORKER_CONTINUITY_METADATA,
  CATALOG_WORKER_SESSION_METADATA,
  loadRuntimeConfig,
  validateCatalogWorkerContinuityMetadata,
  validateCatalogWorkerSessionMetadata,
  type CatalogWorkerContinuityMetadataV1,
  type CatalogWorkerSessionMetadataV1,
  type OutputArtifactMetadata,
} from "@penny/orchestration/source";

const logger = createLogger("compaction");

// ============================================================
// .env fallback loader for host-owned service credentials when Pi was
// launched without exporting the repository's private environment.
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
  /** Consecutive byte-identical Goal count at which the canary logs. */
  goalStagnationThreshold: 3,
};

// ============================================================
// Skill Invocation Detection
// ============================================================

export interface SkillInvocation {
  skill_name: string;
  session_id?: string;
  goal: string;
  completed: boolean;
  result_status: SkillResultStatus;
  result_summary?: string;
  constraints?: Record<string, unknown>;
}

interface ExactToolCallPair {
  callIndex: number;
  blockIndex: number;
  callId: string;
  tool: string;
  params?: Record<string, unknown>;
  resultIndex: number;
  result: SessionMessage;
}

/** Pair globally unique call/result IDs in causal order; ambiguity is omission. */
function collectExactToolCallPairs(
  messages: SessionMessage[],
  toolName?: string
): ExactToolCallPair[] {
  const calls = new Map<
    string,
    Array<{
      callIndex: number;
      blockIndex: number;
      tool: string;
      params?: Record<string, unknown>;
    }>
  >();
  const results = new Map<string, Array<{ resultIndex: number; result: SessionMessage }>>();

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
        const block = message.content[blockIndex];
        if (
          block.type !== "toolCall" ||
          typeof block.id !== "string" ||
          block.id.length === 0 ||
          typeof block.name !== "string" ||
          block.name.length === 0
        ) {
          continue;
        }
        const entries = calls.get(block.id) ?? [];
        entries.push({
          callIndex: messageIndex,
          blockIndex,
          tool: block.name,
          ...(block.arguments ? { params: block.arguments } : {}),
        });
        calls.set(block.id, entries);
      }
    }
    if (
      message.role === "toolResult" &&
      typeof message.toolCallId === "string" &&
      message.toolCallId.length > 0
    ) {
      const entries = results.get(message.toolCallId) ?? [];
      entries.push({ resultIndex: messageIndex, result: message });
      results.set(message.toolCallId, entries);
    }
  }

  const pairs: ExactToolCallPair[] = [];
  for (const [callId, callEntries] of calls) {
    const resultEntries = results.get(callId);
    if (callEntries.length !== 1 || resultEntries?.length !== 1) continue;
    const call = callEntries[0];
    const result = resultEntries[0];
    if (
      result.resultIndex <= call.callIndex ||
      (result.result.toolName !== undefined && result.result.toolName !== call.tool) ||
      (toolName !== undefined && call.tool !== toolName)
    ) {
      continue;
    }
    pairs.push({ ...call, callId, ...result });
  }
  return pairs.sort((a, b) => a.callIndex - b.callIndex || a.blockIndex - b.blockIndex);
}

export interface ExtractedSkillResultData {
  status: SkillResultStatus;
  success: boolean;
  session_id?: string;
  summary?: string;
  parsed?: ParsedSkillResultDetails;
}

/**
 * Parse the structured result boundary before considering transport status.
 * Prose is never parsed as a substitute for absent, malformed, or unknown-version details.
 */
export function extractResultData(resultMsg: SessionMessage): ExtractedSkillResultData {
  const parsed = parseSkillResultDetails(resultMsg.details);
  if (parsed) {
    const status =
      resultMsg.isError === true && parsed.status !== "failure" ? "unknown" : parsed.status;
    return {
      status,
      success: status === "success",
      ...(parsed.sessionId ? { session_id: parsed.sessionId } : {}),
      ...(parsed.summary ? { summary: parsed.summary } : {}),
      parsed,
    };
  }
  if (resultMsg.isError === true) return { status: "failure", success: false };
  return { status: "unknown", success: false };
}

/**
 * Scan messages newest-first for the most recent `skill` tool call. Result
 * metadata is accepted only from one exact, unique call/result ID pair.
 */
export function detectDominantSkill(messages: SessionMessage[]): SkillInvocation | null {
  const pairs = collectExactToolCallPairs(messages, "skill");
  const pairsByCall = new Map(
    pairs.map((pair) => [`${pair.callIndex}:${pair.blockIndex}`, pair] as const)
  );

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    for (let blockIndex = msg.content.length - 1; blockIndex >= 0; blockIndex--) {
      const block = msg.content[blockIndex];
      if (block.type !== "toolCall" || block.name !== "skill" || !block.arguments) continue;

      const skillName =
        typeof block.arguments.skill_name === "string" ? block.arguments.skill_name.trim() : "";
      const goal = typeof block.arguments.goal === "string" ? block.arguments.goal.trim() : "";
      if (!skillName || !goal) continue;

      const pair = pairsByCall.get(`${i}:${blockIndex}`);
      let resultData: ExtractedSkillResultData = { status: "unknown", success: false };
      if (pair) {
        const candidate = extractResultData(pair.result);
        // A structurally valid result for another skill is still an invalid pair.
        if (!candidate.parsed || candidate.parsed.skillName === skillName) resultData = candidate;
      }

      const rawConstraints = block.arguments.constraints;
      return {
        skill_name: skillName,
        ...(resultData.session_id ? { session_id: resultData.session_id } : {}),
        goal: goal.slice(0, 500),
        completed: resultData.status === "success",
        result_status: resultData.status,
        ...(resultData.summary ? { result_summary: resultData.summary } : {}),
        ...(isRecord(rawConstraints) ? { constraints: rawConstraints } : {}),
      };
    }
  }

  return null;
}

// ============================================================
// Message Extraction
// ============================================================

interface ExtractedState {
  goal: string;
  constraints: string[];
  /** True when the dominant skill's goal was displaced by a later user turn. */
  superseded: boolean;
}

/**
 * Find the chronologically latest textual user input.
 *
 * There is deliberately no minimum length or keyword gate: a short pivot can
 * be the user's clearest current goal, and silently restoring older completed
 * work is more harmful than preserving a terse latest instruction.
 */
function newestUserMessage(messages: SessionMessage[]): { text: string; index: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    const content = extractTextContent(msg)?.replace(/\s+/g, " ").trim();
    if (content) return { text: content.slice(0, 500), index: i };
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
 * Extract the session goal and explicit constraints (the deterministic LOAN
 * fallback path — the model path derives the goal from the conversation).
 * Precedence puts recency ahead of stale durable state (RC3 fix):
 *
 *   1. newest user message after the dominant skill call (latest pivot)
 *   2. dominant skill goal, regardless of its honest terminal status
 *   3. newest user message in the merged window
 *   4. exact checkpoint run goal
 *   5. previousSummary carry-forward (never overrides fresh input)
 *   6. system message
 *   7. default (caller supplies)
 *
 * Supersession is status-independent: any later textual user input displaces
 * the older skill goal. This prevents both completed and terminally failed
 * work from being misrepresented as the current request.
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

  const newestUser = newestUserMessage(messages);

  // Precedence #1/#2: a later user turn supersedes the dominant skill;
  // otherwise the explicit skill call still defines that invocation's goal.
  if (dominantSkill?.goal) {
    const skillIdx = latestSkillCallIndex(messages);
    if (newestUser && newestUser.index > skillIdx) {
      goal = newestUser.text;
      superseded = true;
    } else {
      goal = dominantSkill.goal.slice(0, 500);
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

  // Precedence #3: newest user input beats stale durable state.
  if (!goal && newestUser) goal = newestUser.text;

  // Precedence #4: exact checkpoint run goal.
  if (!goal && engineRunGoal) {
    goal = engineRunGoal.slice(0, 500);
  }

  // Precedence #5: carry forward the prior Goal only without fresher input.
  if (!goal && previousSummaryGoal) {
    goal = previousSummaryGoal.slice(0, 500);
  }

  // Precedence #6: system message.
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

  if (input.dominantSkill) {
    const skill = input.dominantSkill;
    const statusLine: Partial<Record<SkillResultStatus, string>> = {
      paused: `Skill "${skill.skill_name}" is paused — ${skill.goal}`,
      failure: `Skill "${skill.skill_name}" failed — ${skill.goal}`,
      incomplete: `Skill "${skill.skill_name}" ended incomplete — ${skill.goal}`,
      cancelled: `Skill "${skill.skill_name}" was cancelled — ${skill.goal}`,
    };
    current_work = statusLine[skill.result_status]?.slice(0, 1000);
  }
  if (!current_work && input.engineRuns.length > 0) {
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
  if (maxCalls <= 0) return [];
  return collectExactToolCallPairs(messages)
    .filter(
      (pair): pair is ExactToolCallPair & { params: Record<string, unknown> } =>
        pair.params !== undefined
    )
    .slice(-maxCalls)
    .map((pair) => ({
      tool: pair.tool,
      params: pair.params,
      successful: !isToolResultError(pair.result),
    }));
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
  if (maxPairs <= 0) return [];
  const exactPairs = collectExactToolCallPairs(messages).filter(
    (pair): pair is ExactToolCallPair & { params: Record<string, unknown> } =>
      pair.params !== undefined
  );
  const recoveries: ToolErrorRecovery[] = [];

  for (let index = 0; index < exactPairs.length && recoveries.length < maxPairs; index++) {
    const failed = exactPairs[index];
    if (!isToolResultError(failed.result)) continue;

    const retry = exactPairs
      .slice(index + 1)
      .find(
        (candidate) =>
          candidate.tool === failed.tool &&
          candidate.callIndex > failed.resultIndex &&
          candidate.params !== undefined &&
          !isToolResultError(candidate.result)
      );
    if (!retry?.params) continue;

    recoveries.push({
      tool: failed.tool,
      failed_params: failed.params,
      error_message: failed.result.content?.toString().slice(0, 200) || "Unknown error",
      corrected_params: retry.params,
    });
  }

  return recoveries;
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

function evictionPriority<T>(field: string, item: T, isError: boolean = false): EvictableItem<T> {
  let priority = 7;
  const confidenceOrdinal = 2;
  let ts = Date.now();

  const rec = asRecord(item);
  const lastUpdated = asString(rec.last_updated);

  if (isError && rec.resolved === false) {
    priority = 1;
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
  isError: boolean = false
): { kept: T[]; evicted: number; log: EvictionRecord[] } {
  if (items.length <= maxCount) {
    return { kept: items, evicted: 0, log: [] };
  }

  const scored = items.map((item) => evictionPriority(field, item, isError));
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
  scale: number = 1
): PennyCompactArtifact {
  const evictionLog: EvictionRecord[] = [];
  const cap = (n: number) => Math.max(1, Math.floor(n * scale));

  const apply = <T>(field: string, items: T[], max: number, isErr = false): T[] => {
    if (items.length > max) {
      const r = evictArray(field, items, max, isErr);
      evictionLog.push(...r.log);
      return r.kept;
    }
    return items;
  };

  artifact.constraints = apply("constraints", artifact.constraints, cap(20));
  artifact.preferences = apply("preferences", artifact.preferences, cap(10));
  artifact.errors = apply("errors", artifact.errors, cap(10), true);
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

export function createResumeRefSet(
  runs: PennyCompactArtifact["engine_runs"],
  artifacts: ArtifactRef[],
  memoryIds: string[] = [],
  priorArtifactRefs: ResumeRef[] = []
): PennyCompactArtifact["resume_refs"] {
  const runRefs: ResumeRef[] = runs.map((run) => ({ type: "run", run_id: run.run_id }));
  const artifactRefs: ResumeRef[] = artifacts.map((artifact) => ({
    type: "artifact",
    artifact_id: artifact.artifact_id,
    digest: artifact.content_digest,
  }));
  const memoryRefs: ResumeRef[] = memoryIds.map((memoryId) => ({
    type: "memory",
    memory_id: memoryId,
  }));
  const refs: ResumeRef[] = [...runRefs, ...artifactRefs, ...priorArtifactRefs, ...memoryRefs];
  const unique = [
    ...new Map(
      refs.map((ref) => [
        ref.type === "run"
          ? `run:${ref.run_id}`
          : ref.type === "artifact"
            ? `artifact:${ref.artifact_id}@${ref.digest}`
            : `memory:${ref.memory_id}`,
        ref,
      ])
    ).values(),
  ];
  return ResumeRefSetSchema.parse({ version: RESUME_REFS_VERSION, refs: unique });
}

/** Parse one exact, versioned refs block. Unknown versions/lines fail closed. */
export function parseResumeRefs(summary: string | undefined): PennyCompactArtifact["resume_refs"] {
  if (!summary) return { version: RESUME_REFS_VERSION, refs: [] };
  const openers = Array.from(summary.matchAll(/\[RESUME-REFS v(\d+)\]/g));
  if (openers.length === 0) return { version: RESUME_REFS_VERSION, refs: [] };
  const opener = openers.at(-1);
  if (!opener || Number(opener[1]) !== RESUME_REFS_VERSION || opener.index === undefined) {
    throw new Error("unsupported RESUME-REFS version");
  }
  const bodyStart = opener.index + opener[0].length;
  const bodyEnd = summary.indexOf("[/RESUME-REFS]", bodyStart);
  if (bodyEnd < 0) throw new Error("unterminated RESUME-REFS block");

  const refs: ResumeRef[] = [];
  for (const rawLine of summary.slice(bodyStart, bodyEnd).split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("run:")) {
      refs.push({ type: "run", run_id: line.slice("run:".length) });
      continue;
    }
    const artifact = /^artifact:(art_[0-9a-f]{64})@sha256:([0-9a-f]{64})$/.exec(line);
    if (artifact) {
      refs.push({ type: "artifact", artifact_id: artifact[1], digest: artifact[2] });
      continue;
    }
    if (line.startsWith("memory:")) {
      refs.push({ type: "memory", memory_id: line.slice("memory:".length) });
      continue;
    }
    throw new Error("invalid RESUME-REFS line");
  }
  const parsed = ResumeRefSetSchema.parse({ version: RESUME_REFS_VERSION, refs });
  const keys = parsed.refs.map((ref) =>
    ref.type === "run"
      ? `run:${ref.run_id}`
      : ref.type === "artifact"
        ? `artifact:${ref.artifact_id}@${ref.digest}`
        : `memory:${ref.memory_id}`
  );
  if (new Set(keys).size !== keys.length) throw new Error("duplicate RESUME-REFS entry");
  return parsed;
}

/** Render only exact, schema-validated addresses. */
export function buildResumeRefs(artifact: PennyCompactArtifact): string {
  const refSet = ResumeRefSetSchema.parse(artifact.resume_refs);
  if (refSet.refs.length === 0) return "";
  const lines = refSet.refs.map((ref) => {
    if (ref.type === "run") return `run:${ref.run_id}`;
    if (ref.type === "artifact") {
      return `artifact:${ref.artifact_id}@sha256:${ref.digest}`;
    }
    return `memory:${ref.memory_id}`;
  });
  return [`[RESUME-REFS v${RESUME_REFS_VERSION}]`, ...lines, "[/RESUME-REFS]"].join("\n");
}

function workerContinuitySection(
  artifact: PennyCompactArtifact,
  continuity: TrustedWorkerContinuity | undefined
): string[] {
  if (continuity === undefined) return [];
  const contextRef = artifact.artifact_refs.find(
    (ref) =>
      ref.kind === "worker-compaction-context" &&
      ref.producer === "extension:compaction" &&
      ref.run_id === continuity.session.run_id &&
      ref.phase === continuity.session.state_id &&
      ref.branch_id === continuity.session.branch_id
  );
  if (contextRef === undefined) return [];
  return [
    "## Worker Continuity",
    `- Continue the exact **${continuity.session.purpose}** assignment for agent **${continuity.session.agent}** in orchestration run \`${continuity.session.run_id}\`, state **${continuity.session.state_id}**${continuity.session.branch_id === null ? "" : `, branch **${continuity.session.branch_id}**`}.`,
    `- Before doing more work, read \`${contextRef.artifact_id}\`; it contains the complete authoritative opening, task, registered guidance, and verified input artifact refs. Use its direct RESUME-REFS entry when present, otherwise resolve it through the handoff-index artifact in RESUME-REFS.`,
    "- Finish with the registered result framing. Do not substitute an ordinary narrative answer for the required worker result.",
    "",
  ];
}

/**
 * Convert a PennyCompactArtifact to the summary spliced into context:
 * a prose markdown brief (Pi-native style, human-readable in the TUI)
 * followed by the [RESUME-REFS] pointer appendix.
 */
export function createProseSummary(
  artifact: PennyCompactArtifact,
  continuity?: TrustedWorkerContinuity
): string {
  const lines: string[] = [];

  // Goal
  lines.push(`## Goal`);
  lines.push(artifact.goal || "(not set)");
  lines.push("");

  lines.push(...workerContinuitySection(artifact, continuity));

  // Dominant skill continuity, including honest terminal/non-terminal status.
  if (artifact.dominant_skill) {
    const ds = artifact.dominant_skill;
    const supersededTag = ds.superseded ? ", superseded by a newer request" : "";
    lines.push(`## Skill Continuity`);
    lines.push(`- **${ds.skill_name}** (${ds.result_status}${supersededTag})`);
    if (ds.goal && ds.goal !== artifact.goal) {
      lines.push(`- Skill goal: ${ds.goal}`);
    }
    if (ds.result_summary) lines.push(`- Result: ${ds.result_summary}`);
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

interface TrustedWorkerContinuity {
  readonly session: CatalogWorkerSessionMetadataV1;
  readonly assignment: CatalogWorkerContinuityMetadataV1;
}

interface WorkerContinuityBranchEntry {
  readonly customType?: string;
  readonly data?: unknown;
}

type WorkerContinuityAdmission =
  | { readonly status: "absent" }
  | { readonly status: "rejected" }
  | { readonly status: "trusted"; readonly continuity: TrustedWorkerContinuity };

function sameWorkerIdentity(
  session: CatalogWorkerSessionMetadataV1,
  assignment: CatalogWorkerContinuityMetadataV1
): boolean {
  return (
    session.project_id === assignment.project_id &&
    session.run_id === assignment.run_id &&
    session.workflow_session_id === assignment.workflow_session_id &&
    session.state_id === assignment.state_id &&
    session.branch_id === assignment.branch_id &&
    session.attempt === assignment.attempt &&
    session.worker_id === assignment.worker_id &&
    session.agent === assignment.agent &&
    session.purpose === assignment.purpose
  );
}

/** Admit only one exact, strictly validated pair authored by the worker-session owner. */
export function collectTrustedWorkerContinuity(
  entries: readonly WorkerContinuityBranchEntry[],
  expectedProjectId: string
): WorkerContinuityAdmission {
  const sessionEntries = entries.filter(
    (entry) => entry.customType === CATALOG_WORKER_SESSION_METADATA
  );
  const assignmentEntries = entries.filter(
    (entry) => entry.customType === CATALOG_WORKER_CONTINUITY_METADATA
  );
  if (sessionEntries.length === 0) return { status: "absent" };
  if (sessionEntries.length !== 1 || assignmentEntries.length !== 1) {
    return { status: "rejected" };
  }
  try {
    const session = validateCatalogWorkerSessionMetadata(sessionEntries[0]?.data);
    const assignment = validateCatalogWorkerContinuityMetadata(assignmentEntries[0]?.data);
    if (session.project_id !== expectedProjectId || !sameWorkerIdentity(session, assignment)) {
      return { status: "rejected" };
    }
    return { status: "trusted", continuity: { session, assignment } };
  } catch (error) {
    logger.warn("Worker continuity metadata rejected", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "rejected" };
  }
}

interface BuildArtifactInput {
  sessionId: string;
  compactionSeq: number;
  projectRoot: string;
  workerContinuity?: TrustedWorkerContinuity;
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
  /** The user's focus hint (Pi event.customInstructions). Sink + Next Steps. */
  customInstructions?: string;
  /** previous/current firstKeptEntryId shift, computed from branchEntries. */
  boundaryShift?: BoundaryShiftRecord;
  /** The compaction event's abort signal (reserved; the model path is signal-
   *  wired in the handler). */
  signal?: AbortSignal;
}

// ============================================================
// Exact run-id collection — no active-run or session-room discovery
// ============================================================

function addCanonicalRunId(ids: Set<string>, value: unknown): void {
  const parsed = ResumeRefSetSchema.safeParse({
    version: RESUME_REFS_VERSION,
    refs: [{ type: "run", run_id: value }],
  });
  const ref = parsed.success ? parsed.data.refs[0] : undefined;
  if (ref?.type === "run") ids.add(ref.run_id);
}

function addRunIdFromArtifactCandidate(ids: Set<string>, value: unknown): void {
  const parsed = ArtifactRefSchema.safeParse(value);
  if (parsed.success) addCanonicalRunId(ids, parsed.data.run_id);
}

/** Inspect only named fields on a schema-validated skill result. */
function collectRunIdsFromParsedSkillResult(
  parsed: ParsedSkillResultDetails,
  ids: Set<string>
): void {
  for (const node of collectValidatedSkillResultNodes(parsed)) {
    if (node.status === "unknown") continue;
    const details = node.details;
    const pause = asRecord(details.dispatch_pause);
    addCanonicalRunId(ids, pause.run_id);
    addCanonicalRunId(ids, asRecord(pause.identity).run_id);

    addRunIdFromArtifactCandidate(ids, details.output_artifact_ref);
    for (const ref of asArray(details.best_partial_artifact_refs)) {
      addRunIdFromArtifactCandidate(ids, ref);
    }

    const result = asRecord(details.result);
    addRunIdFromArtifactCandidate(ids, result.output_artifact_ref);
    for (const ref of asArray(result.best_partial_artifact_refs)) {
      addRunIdFromArtifactCandidate(ids, ref);
    }

    const escalation = asRecord(details.escalation);
    for (const question of asArray(escalation.questions)) {
      addCanonicalRunId(ids, asRecord(question).approval_run_id);
    }
  }
}

/** Exact run IDs supplied by validated, exactly paired skill tool results. */
export function collectExplicitRunIds(messages: SessionMessage[]): string[] {
  const ids = new Set<string>();
  for (const pair of collectExactToolCallPairs(messages, "skill")) {
    const result = extractResultData(pair.result);
    if (result.parsed && result.status !== "unknown") {
      collectRunIdsFromParsedSkillResult(result.parsed, ids);
    }
  }
  return Array.from(ids);
}

/** Exact run IDs carried through this conversation's prior v2 refs block. */
export function parsePriorRunIds(previousSummary: string | undefined): string[] {
  try {
    return parseResumeRefs(previousSummary).refs.flatMap((ref) =>
      ref.type === "run" ? [ref.run_id] : []
    );
  } catch (error) {
    logger.warn("Prior resume refs rejected", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export function collectExactRunIds(
  messages: SessionMessage[],
  previousSummary: string | undefined
): string[] {
  return Array.from(
    new Set([...collectExplicitRunIds(messages), ...parsePriorRunIds(previousSummary)])
  );
}

function addArtifactCandidate(values: unknown[], value: unknown): void {
  if (value !== undefined && value !== null) values.push(value);
}

function collectSkillArtifactCandidates(parsed: ParsedSkillResultDetails, values: unknown[]): void {
  for (const node of collectValidatedSkillResultNodes(parsed)) {
    if (node.status === "unknown") continue;
    const details = node.details;
    addArtifactCandidate(values, details.output_artifact_ref);
    values.push(...asArray(details.best_partial_artifact_refs));
    const result = asRecord(details.result);
    addArtifactCandidate(values, result.output_artifact_ref);
    values.push(...asArray(result.best_partial_artifact_refs));
  }
}

function collectExplicitInputArtifactIds(messages: SessionMessage[]): string[] {
  const ids = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && /^art_[a-f0-9]{64}$/u.test(value)) ids.add(value);
  };
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 4) return;
    const record = asRecord(value);
    const direct = record.input_artifacts;
    if (Array.isArray(direct)) for (const id of direct) add(id);
    for (const key of ["tasks", "chain", "skills"] as const) {
      const children = record[key];
      if (!Array.isArray(children)) continue;
      for (const child of children) visit(child, depth + 1);
    }
  };
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "toolCall" || (block.name !== "subagent" && block.name !== "skill")) {
        continue;
      }
      visit(block.arguments);
    }
  }
  return [...ids];
}

/**
 * Collect only code-owned current-session communication refs: completed
 * subagent/skill result metadata plus exact IDs explicitly passed later.
 */
export function collectCurrentSessionArtifactRefs(
  messages: SessionMessage[],
  projectRoot = process.env.PROJECT_ROOT || process.cwd()
): ArtifactRef[] {
  const candidates: unknown[] = [];
  for (const pair of collectExactToolCallPairs(messages, "subagent")) {
    const details = asRecord(pair.result.details);
    addArtifactCandidate(candidates, details.finalOutputArtifactRef);
    candidates.push(...asArray(details.outputArtifactRefs));
    for (const result of asArray(details.results)) {
      addArtifactCandidate(candidates, asRecord(result).outputArtifactRef);
    }
  }
  for (const pair of collectExactToolCallPairs(messages, "skill")) {
    const result = extractResultData(pair.result);
    if (result.parsed && result.status !== "unknown") {
      collectSkillArtifactCandidates(result.parsed, candidates);
    }
  }

  let store: ArtifactStore | undefined;
  try {
    const runtimeConfig = loadRuntimeConfig(projectRoot);
    store = ArtifactStore.openExisting(runtimeConfig.artifactRoot, {
      projectId: runtimeConfig.projectId,
    });
    for (const id of collectExplicitInputArtifactIds(messages)) {
      const ref = store.refById(id);
      if (ref !== undefined) candidates.push(ref);
    }
    const refs: ArtifactRef[] = [];
    for (const candidate of candidates) {
      const parsed = ArtifactRefSchema.safeParse(candidate);
      if (!parsed.success) continue;
      const stored = store.refById(parsed.data.artifact_id);
      if (
        stored === undefined ||
        stored.content_digest !== parsed.data.content_digest ||
        stored.byte_length !== parsed.data.byte_length
      ) {
        continue;
      }
      store.readById(stored.artifact_id);
      refs.push(ArtifactRefSchema.parse(stored));
    }
    return [...new Map(refs.map((ref) => [ref.artifact_id, ref])).values()];
  } catch (error) {
    logger.warn("Current-session artifact ref collection failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  } finally {
    store?.close();
  }
}

export function persistWorkerContinuityArtifact(input: {
  readonly projectRoot: string;
  readonly compactionSeq: number;
  readonly continuity: TrustedWorkerContinuity;
}): {
  readonly ref: ArtifactRef;
  readonly verifiedInputArtifacts: readonly ArtifactRef[];
  readonly rejectedInputArtifacts: number;
} {
  const runtimeConfig = loadRuntimeConfig(input.projectRoot);
  using store = ArtifactStore.openExisting(runtimeConfig.artifactRoot, {
    projectId: runtimeConfig.projectId,
  });
  const verifiedInputs: ArtifactRef[] = [];
  for (const candidate of input.continuity.assignment.input_artifacts) {
    const parsed = ArtifactRefSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const stored = store.refById(parsed.data.artifact_id);
    if (
      stored === undefined ||
      stored.content_digest !== parsed.data.content_digest ||
      stored.byte_length !== parsed.data.byte_length
    ) {
      continue;
    }
    store.readById(stored.artifact_id);
    verifiedInputs.push(ArtifactRefSchema.parse(stored));
  }
  const uniqueInputs = [...new Map(verifiedInputs.map((ref) => [ref.artifact_id, ref])).values()];
  const rejectedInputArtifacts =
    input.continuity.assignment.input_artifacts.length - uniqueInputs.length;
  if (rejectedInputArtifacts > 0) {
    throw new Error(
      `${rejectedInputArtifacts} worker input artifact ref(s) failed exact store verification`
    );
  }
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.continuity.session.run_id,
    phase: input.continuity.session.state_id,
    branch_id: input.continuity.session.branch_id,
    kind: "worker-compaction-context",
    operation_id:
      `worker-context:${input.compactionSeq}:${input.continuity.session.worker_id}`.slice(0, 256),
    version: 1,
    producer: "extension:compaction",
    media_type: "application/json; charset=utf-8",
    parent_ref: null,
    upstream_refs: uniqueInputs,
  };
  const ref = store.persist({
    metadata,
    content: JSON.stringify({
      schema_version: 1,
      assignment: {
        ...input.continuity.assignment,
        input_artifacts: uniqueInputs,
      },
      rejected_input_artifact_count: rejectedInputArtifacts,
    }),
  });
  store.readById(ref.artifact_id);
  return {
    ref: ArtifactRefSchema.parse(ref),
    verifiedInputArtifacts: uniqueInputs,
    rejectedInputArtifacts,
  };
}

/** Carry optional durable-memory IDs only when a prior exact block supplied them. */
export function parsePriorMemoryIds(previousSummary: string | undefined): string[] {
  try {
    return parseResumeRefs(previousSummary).refs.flatMap((ref) =>
      ref.type === "memory" ? [ref.memory_id] : []
    );
  } catch {
    return [];
  }
}

export function parsePriorArtifactRefs(previousSummary: string | undefined): ResumeRef[] {
  try {
    return parseResumeRefs(previousSummary).refs.filter((ref) => ref.type === "artifact");
  } catch {
    return [];
  }
}

/**
 * Derive unresolved-error refs from the conversation (RC5, fallback path). A
 * tool result flagged as an error is unresolved unless a LATER result from the
 * same tool succeeded. The MODEL path
 * carries errors in prose instead; this feeds the deterministic fallback's
 * `## Unresolved Errors` and the archive.
 */
export function deriveErrorRefs(messages: SessionMessage[]): ErrorRef[] {
  const errorsByTool = new Map<string, { message: string; index: number }>();
  const successAfter = new Map<string, number>();
  messages.forEach((msg, i) => {
    if (msg.role !== "toolResult") return;
    const tool = msg.toolName || "tool";
    if (isToolResultError(msg)) {
      const text = extractTextContent(msg) || "tool error";
      errorsByTool.set(tool, { message: text.slice(0, 300), index: i });
    } else {
      successAfter.set(tool, i);
    }
  });
  const refs: ErrorRef[] = [];
  for (const [tool, err] of errorsByTool) {
    const recovered = (successAfter.get(tool) ?? -1) > err.index;
    refs.push({
      error_type: tool,
      message: err.message,
      turn_id: "unknown",
      resolved: recovered,
    });
    if (refs.length >= 10) break;
  }
  return refs;
}

async function buildArtifact(input: BuildArtifactInput): Promise<{
  artifact: PennyCompactArtifact;
  digest: string;
  workerContinuityReady: boolean;
}> {
  const now = new Date().toISOString();
  const readFiles = Array.from(input.preparation.fileOps.read);
  const modifiedFiles = [
    ...Array.from(input.preparation.fileOps.written),
    ...Array.from(input.preparation.fileOps.edited),
  ];
  const dominant = detectDominantSkill(input.messages);

  // The query key is an exact run ID from owner-produced tool metadata or the
  // prior v2 appendix. No pending-run list or session correlation exists here.
  const exactRunIds = Array.from(
    new Set([
      ...collectExactRunIds(input.messages, input.preparation.previousSummary),
      ...(input.workerContinuity ? [input.workerContinuity.session.run_id] : []),
    ])
  );
  const explicitMemoryIds = parsePriorMemoryIds(input.preparation.previousSummary);
  const priorArtifactRefs = parsePriorArtifactRefs(input.preparation.previousSummary);
  const checkpoint = readExactCheckpoints(exactRunIds, input.projectRoot);
  const engineRuns = checkpoint.runs;
  const currentSessionRefs = collectCurrentSessionArtifactRefs(input.messages, input.projectRoot);
  const workerIssues: string[] = [];
  let workerContextRefs: ArtifactRef[] = [];
  let workerContinuityReady = input.workerContinuity === undefined;
  if (input.workerContinuity) {
    try {
      const persisted = persistWorkerContinuityArtifact({
        projectRoot: input.projectRoot,
        compactionSeq: input.compactionSeq,
        continuity: input.workerContinuity,
      });
      workerContextRefs = [persisted.ref, ...persisted.verifiedInputArtifacts];
      workerContinuityReady = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      workerIssues.push(`worker continuity artifact persistence failed: ${message}`);
      logger.warn("Worker continuity artifact persistence failed", { error: message });
    }
  }
  const artifactRefs = [
    ...new Map(
      [...workerContextRefs, ...checkpoint.artifactRefs, ...currentSessionRefs].map((ref) => [
        ref.artifact_id,
        ref,
      ])
    ).values(),
  ];
  const pending = await detectPendingState(input.messages).catch((error) => {
    logger.warn("Pending state detection failed", { error: String(error) });
    return null;
  });

  const previousSummaryGoal = parseGoalFromSummary(input.preparation.previousSummary);
  const extracted = extractSessionState(
    input.messages,
    dominant,
    engineRuns[0]?.goal,
    previousSummaryGoal ?? undefined
  );
  const goal =
    input.workerContinuity?.assignment.task.replace(/\s+/gu, " ").trim().slice(0, 500) ||
    extracted.goal ||
    "Active session - goal not yet extracted";
  const previousStreak = parseGoalStreak(input.preparation.previousSummary);
  const goalStreak = computeGoalStreak(goal, previousSummaryGoal, previousStreak);
  if (goalStagnationCanary(goalStreak)) {
    logger.warn("Goal unchanged across consecutive compactions (stagnation canary)", {
      goal: goal.slice(0, 120),
      streak: goalStreak,
      session_id: input.sessionId,
    });
  }

  const derivedWork = deriveWorkContext({
    dominantSkill: extracted.superseded ? null : dominant,
    engineRuns,
    pending,
    goal,
    customInstructions: input.customInstructions,
  });
  const workerContextRef = artifactRefs.find((ref) => ref.kind === "worker-compaction-context");
  const work = input.workerContinuity
    ? {
        current_work: `Continue the exact ${input.workerContinuity.session.purpose} assignment for ${input.workerContinuity.session.agent} in orchestration state ${input.workerContinuity.session.state_id}.`,
        next_steps: [
          ...(workerContextRef
            ? [
                `Read ${workerContextRef.artifact_id} before continuing; it contains the complete authoritative opening, task, registered guidance, and verified input refs.`,
              ]
            : []),
          `Complete the registered ${input.workerContinuity.session.purpose} contract and return its required result framing.`,
        ],
      }
    : derivedWork;
  let artifact: PennyCompactArtifact = {
    schema_version: CONFIG.schemaVersion,
    session_id: input.sessionId,
    compaction_seq: input.compactionSeq,
    compaction_timestamp: now,
    goal,
    constraints: input.workerContinuity
      ? [
          `Continue only the validated ${input.workerContinuity.session.purpose} assignment for this worker branch.`,
          "Follow the registered guidance and required result framing from the exact worker context artifact.",
        ]
      : extracted.constraints,
    preferences: [],
    pending,
    ...(work.current_work ? { current_work: work.current_work } : {}),
    ...(work.next_steps ? { next_steps: work.next_steps } : {}),
    ...(dominant
      ? {
          dominant_skill: {
            skill_name: dominant.skill_name,
            ...(dominant.session_id ? { session_id: dominant.session_id } : {}),
            goal: dominant.goal,
            completed: dominant.completed,
            result_status: dominant.result_status,
            ...(dominant.result_summary ? { result_summary: dominant.result_summary } : {}),
            ...(extracted.superseded ? { superseded: true } : {}),
          },
        }
      : {}),
    errors: deriveErrorRefs(input.messages),
    engine_runs: engineRuns,
    artifact_refs: artifactRefs,
    resume_refs: createResumeRefSet(engineRuns, artifactRefs, explicitMemoryIds, priorArtifactRefs),
    files: { read: readFiles, modified: modifiedFiles },
    tool_calls: extractToolCalls(input.messages),
    tool_error_recovery: extractToolErrorRecovery(input.messages),
    metadata: {
      eviction_log: [],
      pi_boundary: {
        first_kept_entry_id: input.preparation.firstKeptEntryId,
        tokens_before: input.preparation.tokensBefore,
        ...(input.boundaryShift ? { boundary_shift: input.boundaryShift } : {}),
      },
      ...(input.reason ? { compaction_reason: input.reason } : {}),
      ...(input.customInstructions ? { custom_instructions: input.customInstructions } : {}),
      goal_streak: goalStreak,
      compaction_correlation: {
        status: "not_evaluated",
        keys: [`session:${input.sessionId}`, ...exactRunIds.map((runId) => `run:${runId}`)].slice(
          0,
          21
        ),
      },
      ...(checkpoint.issues.length > 0 || workerIssues.length > 0
        ? {
            checkpoint_issues: [...checkpoint.issues, ...workerIssues]
              .slice(0, 20)
              .map((issue) => issue.slice(0, 300)),
          }
        : {}),
    },
  };

  const digest = renderGroundedDigest({
    runs: engineRuns,
    artifacts: artifactRefs,
    pending,
    readFiles,
    modifiedFiles,
    ...(dominant
      ? {
          skill: {
            name: dominant.skill_name,
            status: dominant.result_status,
            goal: dominant.goal,
            superseded: extracted.superseded,
          },
        }
      : {}),
  });
  artifact = applyEviction(artifact);
  artifact.resume_refs = createResumeRefSet(
    artifact.engine_runs,
    artifact.artifact_refs,
    explicitMemoryIds,
    priorArtifactRefs
  );
  return { artifact, digest, workerContinuityReady };
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
// Shared final model-visible result budget
// ============================================================

export function compactionResultBudget(): ToolResultBudget {
  try {
    return resolveToolResultBudget(process.env);
  } catch (error) {
    if (error instanceof ToolResultBudgetConfigError) {
      logger.warn("Invalid compaction result budget; enforcing shared hard defaults", {
        error: error.message,
      });
      return DEFAULT_TOOL_RESULT_BUDGET;
    }
    throw error;
  }
}

function renderRefSet(refSet: PennyCompactArtifact["resume_refs"]): string {
  if (refSet.refs.length === 0) return "";
  const lines = refSet.refs.map((ref) => {
    if (ref.type === "run") return `run:${ref.run_id}`;
    if (ref.type === "artifact") {
      return `artifact:${ref.artifact_id}@sha256:${ref.digest}`;
    }
    return `memory:${ref.memory_id}`;
  });
  return [`[RESUME-REFS v${RESUME_REFS_VERSION}]`, ...lines, "[/RESUME-REFS]"].join("\n");
}

export function persistHandoffIndex(input: {
  sessionId: string;
  compactionSeq: number;
  projectRoot: string;
  resumeRefs: PennyCompactArtifact["resume_refs"];
  artifactRefs: ArtifactRef[];
}): ArtifactRef {
  const artifactResumeRefs = input.resumeRefs.refs.filter((ref) => ref.type === "artifact");
  const byId = new Map(input.artifactRefs.map((ref) => [ref.artifact_id, ref]));
  const records = artifactResumeRefs.map((ref, index) => {
    const full = byId.get(ref.artifact_id);
    return {
      artifact_id: ref.artifact_id,
      digest: ref.digest,
      producing_tool: full?.producer.startsWith("skill:") ? "skill" : "subagent-or-skill-stage",
      mode: full?.kind ?? "artifact",
      agent: full?.producer ?? "unknown",
      branch_or_step: full?.branch_id ?? full?.phase ?? "unknown",
      creation_order: index,
    };
  });
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: `compaction:${input.sessionId}`,
    phase: "handoff-index",
    branch_id: null,
    kind: "handoff-index",
    operation_id: `compaction-handoff-index:${input.compactionSeq}`,
    version: 1,
    producer: "extension:compaction",
    media_type: "application/json; charset=utf-8",
    parent_ref: null,
    upstream_refs: [],
  };
  const runtimeConfig = loadRuntimeConfig(input.projectRoot);
  using store = ArtifactStore.openExisting(runtimeConfig.artifactRoot, {
    projectId: runtimeConfig.projectId,
  });
  const ref = store.persist({
    metadata,
    content: JSON.stringify({ schema_version: 1, records }),
  });
  store.readById(ref.artifact_id);
  return ArtifactRefSchema.parse(ref);
}

export function fitCompactionSummary(
  prose: string,
  resumeRefs: PennyCompactArtifact["resume_refs"],
  budget: ToolResultBudget
): { summary: string; resumeRefs: PennyCompactArtifact["resume_refs"] } {
  const originalCount = resumeRefs.refs.length;
  const refs = [...resumeRefs.refs];

  while (true) {
    const fittedRefs = ResumeRefSetSchema.parse({ version: RESUME_REFS_VERSION, refs });
    const renderedRefs = renderRefSet(fittedRefs);
    const omitted = originalCount - refs.length;
    const suffix =
      (renderedRefs ? `\n\n---\n${renderedRefs}` : "") +
      (omitted > 0 ? `\n\n[${omitted} resume refs omitted by the shared result budget]` : "");
    const source = Buffer.from(prose.trim(), "utf8");
    try {
      const fitted = fitUtf8ToolResult({
        source,
        start: 0,
        end: source.length,
        budget,
        build: (_end, text, truncated) => {
          const marker = truncated ? "\n\n[prose truncated to fit the shared result budget]" : "";
          return createTextToolResult({ summary: `${text}${marker}${suffix}`.trim() });
        },
      });
      const marker = fitted.truncated
        ? "\n\n[prose truncated to fit the shared result budget]"
        : "";
      return {
        summary: `${fitted.text}${marker}${suffix}`.trim(),
        resumeRefs: fittedRefs,
      };
    } catch {
      if (refs.length === 0)
        throw new Error("Compaction metadata cannot fit the shared result budget");
      // Artifact refs are appended after run refs, so they are discarded first.
      refs.pop();
    }
  }
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
function failLoudly(message: string, context?: Record<string, unknown>, error?: Error): void {
  // Error objects are an open JavaScript boundary. Existing extension-specific
  // diagnostic properties remain attached at runtime without becoming part of
  // the shared logger ErrorCode contract.
  logger.error(message, context, error);
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
  customType?: string;
  data?: unknown;
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
  /** Abort signal for the compaction; forwarded to the summarization model. */
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
 * Assemble the summary spliced into context: the prose brief followed by the
 * code-owned [RESUME-REFS] pointer appendix. Used for the MODEL path (the
 * deterministic fallback's createProseSummary already appends refs itself).
 */
export function withResumeRefs(prose: string, artifact: PennyCompactArtifact): string {
  const refs = buildResumeRefs(artifact);
  return refs ? `${prose}\n\n---\n${refs}` : prose;
}

/** Keep the code-selected, recency-ordered goal authoritative on the model path. */
export function enforceSelectedGoal(prose: string, selectedGoal: string): string {
  const goal = selectedGoal.replace(/\s+/g, " ").trim().slice(0, 500);
  const lines = prose.trim().split("\n");
  const start = lines.findIndex((line) => /^#{1,6}\s+Goal\s*$/i.test(line.trim()));
  if (start < 0) return [`## Goal`, goal, "", ...lines].join("\n").trim();

  let end = start + 1;
  while (end < lines.length && !/^#{1,6}\s+/.test(lines[end].trim())) end++;
  return [...lines.slice(0, start), "## Goal", goal, "", ...lines.slice(end)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Insert code-owned worker continuity sourced only from the validated custom-entry pair. */
export function enforceWorkerContinuity(
  prose: string,
  artifact: PennyCompactArtifact,
  continuity?: TrustedWorkerContinuity
): string {
  const section = workerContinuitySection(artifact, continuity);
  if (section.length === 0) return prose;
  const lines = prose.trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!/^#{1,6}\s+Worker Continuity\s*$/iu.test(lines[index]?.trim() ?? "")) continue;
    let end = index + 1;
    while (end < lines.length && !/^#{1,6}\s+/u.test(lines[end]?.trim() ?? "")) end++;
    lines.splice(index, end - index);
  }
  const goalStart = lines.findIndex((line) => /^#{1,6}\s+Goal\s*$/iu.test(line.trim()));
  let insertAt = goalStart >= 0 ? goalStart + 1 : 0;
  while (insertAt < lines.length && !/^#{1,6}\s+/u.test(lines[insertAt]?.trim() ?? "")) {
    insertAt++;
  }
  lines.splice(insertAt, 0, ...section);
  return lines
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** Replace model-inferred skill state with the validated structured result. */
export function enforceSkillContinuity(prose: string, artifact: PennyCompactArtifact): string {
  const skill = artifact.dominant_skill;
  if (!skill) return prose;
  const lines = prose.trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!/^#{1,6}\s+(?:Active Skill|Skill Continuity)\s*$/i.test(lines[index].trim())) continue;
    let end = index + 1;
    while (end < lines.length && !/^#{1,6}\s+/.test(lines[end].trim())) end++;
    lines.splice(index, end - index);
  }

  const goalStart = lines.findIndex((line) => /^#{1,6}\s+Goal\s*$/i.test(line.trim()));
  let insertAt = goalStart >= 0 ? goalStart + 1 : 0;
  while (insertAt < lines.length && !/^#{1,6}\s+/.test(lines[insertAt].trim())) insertAt++;
  const supersededTag = skill.superseded ? ", superseded by a newer request" : "";
  const section = [
    "## Skill Continuity",
    `- **${skill.skill_name}** (${skill.result_status}${supersededTag})`,
    ...(skill.goal !== artifact.goal ? [`- Skill goal: ${skill.goal}`] : []),
    ...(skill.result_summary ? [`- Result: ${skill.result_summary}`] : []),
    "",
  ];
  lines.splice(insertAt, 0, ...section);
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

interface CompactionExtensionAPI {
  on(
    event: "session_before_compact",
    handler: (event: SessionBeforeCompactEvent, context: unknown) => Promise<unknown>
  ): void;
}

function isSummarizerContext(value: unknown): value is SummarizerCtx {
  if (!isRecord(value) || !isRecord(value.modelRegistry)) return false;
  const model = value.model;
  const validModel =
    model === undefined ||
    (isRecord(model) && typeof model.provider === "string" && typeof model.id === "string");
  return (
    validModel &&
    typeof value.modelRegistry.find === "function" &&
    typeof value.modelRegistry.getApiKeyAndHeaders === "function"
  );
}

export default function compactionExtension(pi: CompactionExtensionAPI) {
  observabilityConfig = {
    baseUrl: getEnvVar("PI_OBSERVABILITY_REST_URL") || "http://localhost:8765",
    apiKey: getEnvVar("PI_OBSERVABILITY_API_KEY") || "",
  };

  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: unknown) => {
    const { preparation, branchEntries } = event;
    const projectRootValue = isRecord(ctx) ? ctx.cwd : undefined;
    if (typeof projectRootValue !== "string" || projectRootValue.length === 0) {
      throw new Error("compaction context is missing its trusted project root");
    }
    const projectRoot = resolve(projectRootValue);
    const sessionId =
      branchEntries.length > 0 && branchEntries[0].sessionId
        ? branchEntries[0].sessionId
        : "unknown";
    setSessionId(sessionId);

    // Compute compaction sequence by counting prior compactions in branch
    const compactionSeq = branchEntries.filter((e) => e.type === "compaction").length;

    // Merge both message windows so split-turn context is never dropped.
    const messages = mergeCompactionMessages(preparation);

    let workerContinuity: TrustedWorkerContinuity | undefined;
    const hasWorkerSessionMarker = branchEntries.some(
      (entry) => entry.customType === CATALOG_WORKER_SESSION_METADATA
    );
    if (hasWorkerSessionMarker) {
      let admission: WorkerContinuityAdmission;
      try {
        const runtimeConfig = loadRuntimeConfig(projectRoot);
        admission = collectTrustedWorkerContinuity(branchEntries, runtimeConfig.projectId);
      } catch (error) {
        logger.warn("Worker continuity project binding failed; using Pi default compaction", {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (admission.status !== "trusted") {
        logger.warn("Recognized worker session has no admissible continuity; using Pi default", {
          admission_status: admission.status,
        });
        return;
      }
      workerContinuity = admission.continuity;
    }

    if (workerContinuity?.assignment.compaction_continuity.mode === "pi_default_private_context") {
      logger.info("Using Pi default compaction for owner-resolved private worker context", {
        run_id: workerContinuity.session.run_id,
        state_id: workerContinuity.session.state_id,
      });
      return;
    }

    // boundary_shift is populated on every compaction after the first.
    const boundaryShift = computeBoundaryShift(
      branchEntries,
      preparation.firstKeptEntryId,
      compactionSeq
    );

    const build = await buildArtifact({
      sessionId,
      compactionSeq,
      projectRoot,
      ...(workerContinuity ? { workerContinuity } : {}),
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
    if (workerContinuity !== undefined && !build.workerContinuityReady) {
      logger.warn("Exact worker continuity was unavailable; using Pi default compaction", {
        run_id: workerContinuity.session.run_id,
        state_id: workerContinuity.session.state_id,
      });
      return;
    }
    const artifact = build.artifact;
    const resultBudget = compactionResultBudget();

    // Model-owned prose (the leverage path): the session model summarizes the
    // ACTUAL evicted conversation, given the previous brief + exact checkpoint
    // digest. Returns null on ANY failure (no model/auth, timeout, abort,
    // empty) → the deterministic LOAN fallback, or Pi's default when that loan
    // is ablated.
    const proseTokenTarget = Math.floor(resultBudget.maxEstimatedTokens * 0.66);
    const modelResult = isSummarizerContext(ctx)
      ? await generateModelSummary(
          {
            messages,
            previousSummary: preparation.previousSummary,
            digest: build.digest,
            customInstructions: event.customInstructions,
            proseTokenTarget,
            signal: event.signal,
          },
          ctx
        )
      : null;

    let modelProse: string | null = null;
    if (modelResult) {
      artifact.summary_source = "model";
      artifact.summary_model = modelResult.model;
      // Goal and skill status are code-owned: model prose cannot revive or
      // misclassify an older skill.
      modelProse = enforceWorkerContinuity(
        enforceSkillContinuity(enforceSelectedGoal(modelResult.prose, artifact.goal), artifact),
        artifact,
        workerContinuity
      );
      artifact.prose_summary = modelProse.slice(0, 20_000);
    } else if (loanEnabled("compaction_deterministic_summary")) {
      artifact.summary_source = "deterministic_fallback";
    } else {
      // Loan ablated AND no model reachable → hand back to Pi's default
      // compaction (the scaffold-OFF measurement). The ONLY path where this
      // extension yields the summary.
      failLoudly(
        "Compaction model path failed and deterministic fallback is ablated; using Pi default",
        { session_id: sessionId },
        Object.assign(new Error("compaction yielded to Pi default"), {
          code: "COMPACTION_YIELDED_TO_DEFAULT",
        })
      );
      return;
    }

    // Build prose without an appendix, then fit the final model-visible output
    // with the shared hard budget. Exact refs are removed only at line
    // boundaries (artifacts first) and the resulting set is persisted in
    // details, so the versioned block is never byte-truncated or malformed.
    const proseOnly =
      modelProse !== null
        ? modelProse
        : createProseSummary(
            {
              ...artifact,
              resume_refs: { version: RESUME_REFS_VERSION, refs: [] },
            },
            workerContinuity
          );
    const proseWithCanary = appendGoalStreakMarker(proseOnly, artifact.metadata.goal_streak ?? 0);
    let fitted = fitCompactionSummary(proseWithCanary, artifact.resume_refs, resultBudget);
    if (fitted.resumeRefs.refs.length !== artifact.resume_refs.refs.length) {
      try {
        const indexRef = persistHandoffIndex({
          sessionId,
          compactionSeq,
          projectRoot,
          resumeRefs: artifact.resume_refs,
          artifactRefs: artifact.artifact_refs,
        });
        artifact.artifact_refs = [
          ...artifact.artifact_refs.filter((ref) => ref.artifact_id !== indexRef.artifact_id),
          indexRef,
        ];
        artifact.resume_refs = createResumeRefSet(
          artifact.engine_runs,
          [indexRef],
          parsePriorMemoryIds(preparation.previousSummary)
        );
        fitted = fitCompactionSummary(proseWithCanary, artifact.resume_refs, resultBudget);
        const indexPresent = fitted.resumeRefs.refs.some(
          (ref) => ref.type === "artifact" && ref.artifact_id === indexRef.artifact_id
        );
        const fittedRunIds = new Set(
          fitted.resumeRefs.refs.flatMap((ref) => (ref.type === "run" ? [ref.run_id] : []))
        );
        const missingRunRef = artifact.engine_runs.some((run) => !fittedRunIds.has(run.run_id));
        if (!indexPresent || missingRunRef) {
          throw new Error("handoff-index or exact run reference cannot fit the result budget");
        }
      } catch (error) {
        failLoudly(
          "Exact compaction handoff index could not be persisted; using Pi default compaction",
          { session_id: sessionId },
          Object.assign(error instanceof Error ? error : new Error(String(error)), {
            code: "COMPACTION_HANDOFF_INDEX_FAILED",
          })
        );
        return;
      }
    }
    const proseSummary = fitted.summary;
    artifact.resume_refs = fitted.resumeRefs;
    const summaryMeasurement = measureToolResult(createTextToolResult({ summary: proseSummary }));
    const releaseHeadroom = assessReleaseHeadroom(summaryMeasurement.estimatedTokens);
    artifact.metadata.result_budget = {
      serialized_bytes: summaryMeasurement.bytes,
      serialized_characters: summaryMeasurement.characters,
      estimated_tokens: summaryMeasurement.estimatedTokens,
      release_minimum_context_headroom_tokens: releaseHeadroom.releaseMinimumContextHeadroomTokens,
      required_reserved_after_result_tokens: releaseHeadroom.requiredReservedAfterResultTokens,
      estimated_reserved_after_result_tokens: releaseHeadroom.estimatedReservedAfterResultTokens,
      reserve_invariant_preserved: releaseHeadroom.invariantPreserved,
    };

    // Strict schema/version/ref validation happens after final-budget fitting.
    // A failure is loud but the prose recovery brief is still preferable to
    // dropping compaction entirely.
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
