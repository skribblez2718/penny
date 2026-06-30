/**
 * Penny Custom Compaction Extension - Phase 3
 *
 * Replaces Pi's default prose summary with a structured Penny Compact Artifact.
 *
 * Features:
 *   - session_before_compact hook interception
 *   - Goal/constraints/preferences extraction from session messages
 *   - tiktoken-based exact token counting
 *   - 10-level eviction priority algorithm for cardinality caps
 *   - Stale KG entity cleanup
 *   - zod runtime validation
 */

import { PennyCompactArtifactSchema, type PennyCompactArtifact } from "./schema.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { detectPendingState } from "./pending.js";
import {
  queryMempalaceSkillRooms,
  queryMempalaceSkillRoomsForSession,
  queryAgentSummariesFromRoom,
  querySkillOrchestratorState,
  queryKGEntitiesForSession,
  queryOutcomeLedgerDecisions,
} from "./bridge.js";
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

const _envCache: Record<string, string> | null = null;

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
  schemaVersion: "1.0.0",
  maxArtifactTokens: 6000,
};

// ============================================================
// Skill Invocation Detection (v1.1.0)
// ============================================================

interface SkillInvocation {
  skill_name: string;
  session_id: string;
  goal: string;
  completed: boolean;
}

/**
 * Scan messages to detect the most recent skill invocation.
 *
 * Strategy:
 * 1. Scan assistant messages for "skill" toolCalls with {skill_name, goal}
 * 2. Check subsequent toolResult for session_id, success/failure, result_summary
 * 3. If no skill tool call, scan user messages for skill-related intent
 * 4. Return null if no skill invocation found
 */
function detectDominantSkill(messages: any[]): SkillInvocation | null {
  let dominant: SkillInvocation | null = null;

  // Scan from newest to oldest — most recent skill invocation wins
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type !== "toolCall" || block.name !== "skill" || !block.arguments) continue;

      const skillName = block.arguments.skill_name || "";
      const goal = block.arguments.goal || "";
      if (!skillName || !goal) continue;

      // Check subsequent toolResult for completion status and session_id
      let completed = false;
      let sessionId = "";
      for (let j = i + 1; j < messages.length; j++) {
        const resultMsg = messages[j];
        if (resultMsg.role !== "toolResult") continue;
        if (resultMsg.toolName === "skill" || resultMsg.toolCallId === block.id) {
          const resultData = extractResultData(resultMsg);
          completed = resultData.success || false;
          sessionId = resultData.session_id || "";
          break;
        }
      }

      dominant = {
        skill_name: skillName,
        session_id: sessionId || `${skillName}-${Date.now()}`,
        goal,
        completed,
      };

      // Most recent invocation wins — stop scanning
      return dominant;
    }
  }

  // Fallback: scan user messages for skill-like intent mentions
  for (let i = messages.length - 1; i >= 0 && !dominant; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    const content = extractTextContent(msg);
    if (!content) continue;

    const lower = content.toLowerCase();
    if (/plan skill|research skill/i.test(lower)) {
      const goal = content
        .replace(/run the |invoke the |start the |use the /gi, "")
        .split(/[.\n]/)[0]
        .trim();
      if (goal.length <= 500) {
        // Infer skill name from content
        let skillName = "unknown";
        if (/research/i.test(lower)) skillName = "research";
        else if (/plan/i.test(lower)) skillName = "plan";
        else if (/agent/i.test(lower)) skillName = "agent";

        dominant = {
          skill_name: skillName,
          session_id: `${skillName}-${Date.now()}`,
          goal,
          completed: false,
        };
        return dominant;
      }
    }
  }

  return null;
}

function extractResultData(resultMsg: any) {
  const text = resultMsg.content?.toString() || "";
  try {
    const parsed = JSON.parse(text);
    return {
      success: parsed.success || false,
      session_id: parsed.session_id || "",
      summary: parsed.plan_summary?.goal || parsed.plan?.title || "",
    };
  } catch {
    return { success: false, session_id: "", summary: "" };
  }
}

// ============================================================
// Message Extraction (Revised v1.1.0)
// ============================================================

interface ExtractedState {
  goal: string;
  constraints: string[];
  preferences: string[];
}

/**
 * Extract goal, constraints, and preferences from session messages.
 *
 * REVISED v1.1.0: Goal extraction priority:
 * 1. Most recent skill tool call → use skill.goal
 * 2. Most recent user message with actionable intent
 * 3. System message as last resort (legacy fallback)
 */
function extractSessionState(
  messages: any[],
  dominantSkill?: SkillInvocation | null
): ExtractedState {
  let goal = "";
  const constraints: string[] = [];
  const preferences: string[] = [];

  // v1.1.0: skill-first goal extraction
  if (dominantSkill && dominantSkill.goal) {
    goal = dominantSkill.goal.slice(0, 500);
  }

  for (const msg of messages) {
    const content = extractTextContent(msg);
    if (!content) continue;

    // Legacy: if no skill extracted goal, try to find one from messages
    if (!goal && msg.role === "user") {
      // Try to find the first meaningful user message that doesn't match
      // the "this is confusing" / "fix this" pattern
      const lower = content.toLowerCase();
      const isReactionary =
        lower.includes("wildly confusing") ||
        lower.includes("fix this") ||
        lower.includes("this is wrong") ||
        lower.includes("figure out") ||
        lower.includes("something wrong");
      if (!isReactionary && content.length > 10) {
        goal = content.slice(0, 500);
      }
    }

    if (msg.role === "user") {
      const lower = content.toLowerCase();
      if (
        lower.includes("constraint") ||
        lower.includes("must") ||
        lower.includes("require") ||
        lower.includes("do not") ||
        lower.includes("never")
      ) {
        const sentence = content
          .split(/[.!?\n]/)
          .find((s: string) => /constraint|must|require|do not|never/i.test(s));
        if (sentence && sentence.length <= 200) {
          constraints.push(sentence.trim());
        }
      }
      if (
        lower.includes("prefer") ||
        lower.includes("style") ||
        lower.includes("format") ||
        lower.includes("use ") ||
        lower.includes("option")
      ) {
        const sentence = content
          .split(/[.!?\n]/)
          .find((s: string) => /prefer|style|format|use |option/i.test(s));
        if (sentence && sentence.length <= 200) {
          preferences.push(sentence.trim());
        }
      }
    }
  }

  // Last resort: if still no goal, try system message (legacy)
  if (!goal) {
    for (const msg of messages) {
      const content = extractTextContent(msg);
      if (content && msg.role === "system") {
        goal = content.slice(0, 500);
        break;
      }
    }
  }

  return { goal, constraints, preferences };
}

function extractTextContent(msg: any): string | null {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join(" ");
  }
  return null;
}

// ============================================================
// Tool Call Pattern Extraction (for weak tool-callers)
// ============================================================

interface ToolCallExample {
  tool: string;
  params: Record<string, any>;
  successful: boolean;
}

interface ToolErrorRecovery {
  tool: string;
  failed_params: Record<string, any>;
  error_message: string;
  corrected_params: Record<string, any>;
}

/**
 * Robust error detection for Pi tool result messages.
 * Checks explicit `isError` field first, then scans content for error indicators.
 */
function isToolResultError(msg: any): boolean {
  if (!msg || msg.role !== "toolResult") return false;
  if (msg.isError === true) return true;
  const text = msg.content?.toString().toLowerCase() || "";
  return (
    text.includes("error") ||
    text.includes("failed") ||
    text.includes("validation failed") ||
    text.includes("eisdir") ||
    text.includes("enoent") ||
    text.includes("timeout")
  );
}

/**
 * Extract recent tool call examples from assistant messages.
 * Keeps the last N successful calls to serve as in-context examples
 * for models that learn tool schemas from conversation history.
 */
function extractToolCalls(messages: any[], maxCalls: number = 15): ToolCallExample[] {
  const examples: ToolCallExample[] = [];

  for (let i = messages.length - 1; i >= 0 && examples.length < maxCalls; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type === "toolCall" && block.arguments) {
        // Check if the next message is a tool result (success indicator)
        const nextMsg = messages[i + 1];
        const hasError = isToolResultError(nextMsg);
        const isSuccess = nextMsg?.role === "toolResult" && !hasError;

        examples.push({
          tool: block.name,
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
 * Captures the last few failed attempts and their successful retries
 * to teach the model what NOT to do.
 */
function extractToolErrorRecovery(messages: any[], maxPairs: number = 3): ToolErrorRecovery[] {
  const pairs: ToolErrorRecovery[] = [];

  for (let i = 0; i < messages.length && pairs.length < maxPairs; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type !== "toolCall" || !block.arguments) continue;

      // Look for subsequent toolResult indicating failure
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
              tool: block.name,
              failed_params: block.arguments,
              error_message: nextMsg.content?.toString().slice(0, 200) || "Unknown error",
              corrected_params: retryBlock.arguments,
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
// Eviction Priority Algorithm
// ============================================================

interface EvictableItem {
  value: any;
  priority: number;
  confidenceOrdinal: number;
  timestamp: number;
}

// ============================================================
// Recency-Weighted Eviction Algorithm (v1.1.0)
// ============================================================

function recencyBand(lastUpdated: string): number {
  const ageMs = Date.now() - new Date(lastUpdated).getTime();
  if (ageMs <= 3_600_000) return 3; // ≤ 1 hour
  if (ageMs <= 86_400_000) return 2; // ≤ 24 hours
  if (ageMs <= 604_800_000) return 1; // ≤ 7 days
  return 0; // older
}

interface EvictableItem {
  value: any;
  priority: number;
  confidenceOrdinal: number;
  recencyBand: number;
  timestamp: number;
}

function evictionPriorityV2(
  field: string,
  item: any,
  isError: boolean = false,
  dominantSessionId?: string
): EvictableItem {
  let priority = 7;
  let confidenceOrdinal = 2;
  let ts = Date.now();

  // v1.1.0: Dominant skill room protection (NEVER evict)
  if (field === "mempalace_rooms" && item.room && dominantSessionId) {
    const roomText = item.room.toLowerCase();
    const sessionText = dominantSessionId.toLowerCase();
    if (roomText.includes(sessionText)) {
      return { value: item, priority: 0, confidenceOrdinal: 5, recencyBand: 3, timestamp: ts };
    }
  }

  // v1.1.0: Dominant agents protected
  if (field === "agents_invoked" && item.session_id && dominantSessionId) {
    if (item.session_id.toLowerCase().includes(dominantSessionId.toLowerCase())) {
      return { value: item, priority: 0, confidenceOrdinal: 5, recencyBand: 3, timestamp: ts };
    }
  }

  if (isError && item.resolved === false) {
    priority = 1;
  } else if (field === "pending" && item != null) {
    priority = 2;
  } else if (field === "decisions") {
    switch (item.confidence) {
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
    priority = item.stale ? 8 : 9;
  } else if (field === "metadata.pi_boundary") {
    priority = 10;
  }

  // Extract timestamp from item
  if (item.last_updated) {
    try {
      ts = new Date(item.last_updated).getTime();
    } catch {
      /* use now */
    }
  }

  const recency = recencyBand(item.last_updated || new Date().toISOString());

  return { value: item, priority, confidenceOrdinal, recencyBand: recency, timestamp: ts };
}

function evictArray(
  field: string,
  items: any[],
  maxCount: number,
  isError: boolean = false,
  dominantSessionId?: string
): { kept: any[]; evicted: number; log: any[] } {
  if (items.length <= maxCount) {
    return { kept: items, evicted: 0, log: [] };
  }

  const scored = items.map((item) => evictionPriorityV2(field, item, isError, dominantSessionId));
  scored.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.recencyBand !== b.recencyBand) return b.recencyBand - a.recencyBand;
    if (a.confidenceOrdinal !== b.confidenceOrdinal)
      return b.confidenceOrdinal - a.confidenceOrdinal;
    return a.timestamp - b.timestamp;
  });

  const keepCount = maxCount;
  const kept = scored.slice(0, keepCount).map((s) => s.value);
  const evicted = scored.length - keepCount;

  const log =
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

function applyEviction(
  artifact: PennyCompactArtifact,
  dominantSessionId?: string
): PennyCompactArtifact {
  const evictionLog: any[] = [];

  const apply = (field: string, items: any[], max: number, isErr = false) => {
    if (items.length > max) {
      const r = evictArray(field, items, max, isErr, dominantSessionId);
      evictionLog.push(...r.log);
      return r.kept;
    }
    return items;
  };

  artifact.constraints = apply("constraints", artifact.constraints, 20);
  artifact.preferences = apply("preferences", artifact.preferences, 10);
  artifact.decisions = apply("decisions", artifact.decisions, 20);
  artifact.errors = apply("errors", artifact.errors, 10, true);
  artifact.agents_invoked = apply("agents_invoked", artifact.agents_invoked, 10);
  artifact.mempalace_rooms = apply("mempalace_rooms", artifact.mempalace_rooms, 10);
  artifact.kg_entities = apply("kg_entities", artifact.kg_entities, 20);
  artifact.files.read = apply("files.read", artifact.files.read, 30);
  artifact.files.modified = apply("files.modified", artifact.files.modified, 30);
  artifact.tool_calls = apply("tool_calls", artifact.tool_calls, 15);
  artifact.tool_error_recovery = apply(
    "tool_error_recovery",
    artifact.tool_error_recovery,
    3,
    true
  );

  artifact.metadata.eviction_log = [...artifact.metadata.eviction_log, ...evictionLog].slice(0, 10);

  return artifact;
}

// ============================================================
// Stale Entity Cleanup
// ============================================================

function cleanupStaleEntities(
  entities: any[],
  currentSeq: number,
  maxStaleCycles: number = 3
): any[] {
  return entities.filter((e) => {
    if (!e.stale) return true;
    if (e.valid_from) {
      const age = currentSeq;
      return age < maxStaleCycles;
    }
    return false;
  });
}

// ============================================================
// Prose Summary Builder (v1.2.0 — silent console)
// ============================================================

/**
 * Convert a PennyCompactArtifact to a prose markdown summary.
 *
 * Pi's native compaction produces prose that the model processes as
 * context — it is NOT echoed back to the console. Our previous JSON
 * artifact was frequently regurgitated by the model, creating noise.
 *
 * The prose format follows Pi's native compaction style (markdown
 * sections) so it blends into context and the TUI collapsed/expanded
 * view is human-readable instead of a wall of JSON.
 *
 * The FULL structured artifact is still archived in observability
 * (POST /compactions) — the prose is only for the model context.
 */
function createProseSummary(artifact: PennyCompactArtifact): string {
  const lines: string[] = [];

  // Goal
  lines.push(`## Goal`);
  lines.push(artifact.goal || "(not set)");
  lines.push("");

  // Dominant skill
  if (artifact.dominant_skill) {
    const ds = artifact.dominant_skill;
    lines.push(`## Active Skill`);
    lines.push(`- **${ds.skill_name}** (${ds.completed ? "complete" : "incomplete"})`);
    if (ds.goal && ds.goal !== artifact.goal) {
      lines.push(`- Goal: ${ds.goal}`);
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

  // Constraints
  const realConstraints = artifact.constraints.filter(
    (c) => c !== "No explicit constraints recorded"
  );
  if (realConstraints.length > 0) {
    lines.push(`## Constraints`);
    for (const c of realConstraints.slice(0, 5)) {
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

  // Agents
  if (artifact.agents_invoked.length > 0) {
    const seen = new Set<string>();
    const agents = artifact.agents_invoked
      .filter((a) => {
        const key = `${a.name}|${a.session_id}|${a.phase}|${a.complete}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 5);
    if (agents.length > 0) {
      lines.push(`## Agents Invoked`);
      for (const a of agents) {
        lines.push(`- ${a.name} (${a.phase}, ${a.complete ? "complete" : "incomplete"})`);
      }
      lines.push("");
    }
  }

  // Rooms
  if (artifact.mempalace_rooms.length > 0) {
    lines.push(`## Mempalace Rooms`);
    for (const r of artifact.mempalace_rooms.slice(0, 5)) {
      const marker = r.dominant_for_session ? " ★" : "";
      lines.push(`- ${r.wing}/${r.room}${marker}`);
    }
    lines.push("");
  }

  // Tool patterns
  if (artifact.tool_calls.length > 0) {
    const successful = artifact.tool_calls.filter((t) => t.successful).map((t) => t.tool);
    const failed = artifact.tool_calls.filter((t) => !t.successful).map((t) => t.tool);
    if (successful.length > 0 || failed.length > 0) {
      lines.push(`## Tool Usage`);
      if (successful.length > 0) {
        lines.push(`- Successful: ${[...new Set(successful)].join(", ")}`);
      }
      if (failed.length > 0) {
        lines.push(`- Failed: ${[...new Set(failed)].join(", ")}`);
      }
      lines.push("");
    }
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

  return lines.join("\n").trim();
}

// ============================================================
// Artifact Builder
// ============================================================

interface BuildArtifactInput {
  sessionId: string;
  compactionSeq: number;
  messages: any[];
  preparation: {
    firstKeptEntryId: string;
    tokensBefore: number;
    fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> };
    previousSummary?: string;
  };
}

async function buildArtifact(input: BuildArtifactInput): Promise<PennyCompactArtifact> {
  const now = new Date().toISOString();
  const seq = input.compactionSeq;

  const readFiles = Array.from(input.preparation.fileOps.read);
  const modifiedFiles = [
    ...Array.from(input.preparation.fileOps.written),
    ...Array.from(input.preparation.fileOps.edited),
  ];

  // ============================================================
  // v1.1.0: Session-First Build
  // ============================================================

  // Step 1: Detect dominant skill (CRITICAL for session scoping)
  const dominant = detectDominantSkill(input.messages);

  // Step 2: Extract state — goal from dominant skill, then fall back
  const extracted = extractSessionState(input.messages, dominant);

  // Step 3: Detect pending escalation state
  const pending = await detectPendingState(input.messages, input.sessionId);

  // Step 4: Query mempalace with session scoping
  let mempalaceRooms: any[] = [];
  let agentsInvoked: any[] = [];
  let orcState: any = null;

  try {
    if (dominant) {
      // v1.1.0: Session-scoped query — only rooms for the dominant skill
      mempalaceRooms = await queryMempalaceSkillRoomsForSession(dominant.session_id);

      // Mark dominant rooms
      for (const room of mempalaceRooms) {
        room.dominant_for_session =
          room.room?.includes(dominant.session_id) || room.room?.includes(dominant.skill_name);
      }

      // Query actual agent summaries from mempalace drawers
      for (const room of mempalaceRooms) {
        try {
          const roomAgents = await queryAgentSummariesFromRoom(room);
          agentsInvoked.push(...roomAgents);
        } catch (err) {
          logger.debug("Agent summary query failed for room", {
            room: room.room,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Query orchestrator state if skill appears incomplete
      if (agentsInvoked.some((a: any) => !a.complete)) {
        try {
          orcState = await querySkillOrchestratorState(dominant.session_id);
        } catch (err) {
          logger.debug("Orchestrator state query failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Fallback: only if no dominant skill was detected at all.
    // If we have a dominant skill but no scoped rooms, we trust that
    // the session simply hasn't created mempalace data yet — flooding
    // the artifact with unrelated inferred agents is worse than omission.
    if (mempalaceRooms.length === 0 && !dominant) {
      mempalaceRooms = await queryMempalaceSkillRooms();
      // Legacy: infer from room names, but deduplicate by skill name
      const seen = new Set<string>();
      agentsInvoked = mempalaceRooms
        .map((r: any) => {
          const match = r.room?.match(/^skills\/([^-]+)-/);
          return {
            name: match ? match[1] : "unknown",
            session_id: input.sessionId,
            phase: "unknown",
            complete: false,
            source: "inferred",
          };
        })
        .filter((a: any) => {
          if (seen.has(a.name)) return false;
          seen.add(a.name);
          return true;
        });
    }
  } catch (err) {
    logger.error(
      "Mempalace query failed during compaction",
      { error: err instanceof Error ? err.message : String(err) },
      Object.assign(new Error("Mempalace query failed"), {
        code: "COMPACTION_MEMPALACE_QUERY_FAILED",
      })
    );
  }

  // Query KG for session entities (Item 2)
  let kgEntities: any[] = [];
  try {
    kgEntities = await queryKGEntitiesForSession(input.sessionId);
  } catch (err) {
    logger.error(
      "KG query failed during compaction",
      { error: err instanceof Error ? err.message : String(err) },
      Object.assign(new Error("KG query failed"), { code: "COMPACTION_KG_QUERY_FAILED" })
    );
  }

  // Query outcome ledger for decisions (Item 3)
  let decisions: any[] = [];
  try {
    decisions = await queryOutcomeLedgerDecisions(20);
  } catch (err) {
    logger.error(
      "Outcome ledger query failed during compaction",
      { error: err instanceof Error ? err.message : String(err) },
      Object.assign(new Error("Outcome ledger query failed"), {
        code: "COMPACTION_OUTCOME_QUERY_FAILED",
      })
    );
  }

  let artifact: PennyCompactArtifact = {
    schema_version: CONFIG.schemaVersion,
    session_id: input.sessionId,
    compaction_seq: seq,
    compaction_timestamp: now,

    goal: extracted.goal || "Active session - goal not yet extracted",
    constraints:
      extracted.constraints.length > 0
        ? extracted.constraints
        : ["No explicit constraints recorded"],
    preferences: extracted.preferences,
    pending,

    // v1.1.0: Track the dominant skill explicitly
    dominant_skill: dominant
      ? {
          skill_name: dominant.skill_name,
          session_id: dominant.session_id,
          goal: dominant.goal,
          completed: dominant.completed,
        }
      : undefined,

    decisions,
    errors: [],

    agents_invoked: agentsInvoked,
    orchestrator_state: orcState,

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
      },
    },
  };

  // v1.1.0: Apply eviction with dominant session protection
  artifact = applyEviction(artifact, dominant?.session_id);
  artifact.kg_entities = cleanupStaleEntities(artifact.kg_entities, seq, 3);

  return artifact;
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
// Serialization
// ============================================================

function serializeArtifact(artifact: PennyCompactArtifact): string {
  const compact = JSON.stringify(artifact);
  return `[COMPACT-ARTIFACT schema_version="${artifact.schema_version}" session_id="${artifact.session_id}" seq="${artifact.compaction_seq}"]\n${compact}\n[/COMPACT-ARTIFACT]`;
}

// ============================================================
// Token Estimation (tiktoken)
// ============================================================

let tiktokenEncoder: any = null;

function getEncoder() {
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

export default function compactionExtension(pi: ExtensionAPI) {
  observabilityConfig = {
    baseUrl: getEnvVar("PI_OBSERVABILITY_REST_URL") || "http://localhost:8765",
    apiKey: getEnvVar("PI_OBSERVABILITY_API_KEY") || "",
  };

  pi.on("session_before_compact", async (event) => {
    const { preparation, branchEntries } = event;
    const sessionId =
      branchEntries.length > 0 && branchEntries[0].sessionId
        ? branchEntries[0].sessionId
        : "unknown";
    setSessionId(sessionId);

    // Compute compaction sequence by counting prior compactions in branch
    const compactionSeq = branchEntries.filter((e: any) => e.type === "compaction").length;

    const artifact = await buildArtifact({
      sessionId,
      compactionSeq,
      messages: preparation.messagesToSummarize || [],
      preparation: {
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        fileOps: preparation.fileOps,
        previousSummary: preparation.previousSummary,
      },
    });

    const validation = validateArtifact(artifact);
    if (!validation.valid) {
      failLoudly(
        "Compaction artifact validation failed",
        { errors: validation.errors },
        Object.assign(new Error(validation.errors.join("; ")), {
          code: "COMPACTION_VALIDATION_FAILED",
        })
      );
      return;
    }

    // Build prose summary for conversation context (model-readable, console-silent)
    const proseSummary = createProseSummary(artifact);
    const summaryTokens = estimateTokens(proseSummary);

    if (summaryTokens > CONFIG.maxArtifactTokens) {
      failLoudly(
        "Compaction token budget exceeded",
        { budget: CONFIG.maxArtifactTokens, actual: summaryTokens },
        Object.assign(new Error(`Token budget ${summaryTokens} > ${CONFIG.maxArtifactTokens}`), {
          code: "COMPACTION_BUDGET_OVERFLOW",
        })
      );
      return;
    }

    // Fire-and-forget: send FULL artifact to observability backend.
    // On the SUCCESS path this is completely silent — no console noise.
    postCompactionArtifact(artifact, preparation.firstKeptEntryId, preparation.tokensBefore).then(
      () => {},
      (postErr) => {
        // Archive post failure is non-fatal for compaction itself, but the
        // user asked to be notified. Warn to observability.
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
