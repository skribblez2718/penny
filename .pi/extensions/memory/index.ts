/**
 * Memory Extension for Penny
 *
 * Provides 21 MemPalace tools for AI memory:
 * - Palace (read): status, list_wings, list_rooms, get_taxonomy, search, smart_search, check_duplicate, get_aaak_spec
 * - Palace (bulk): list_drawers, delete_drawers_by_room
 * - Palace (write): add_drawer, delete_drawer
 * - Knowledge Graph: kg_query, kg_add, kg_invalidate, kg_timeline, kg_stats
 * - Navigation: traverse, find_tunnels, graph_stats
 * - Agent Diary: diary_write, diary_read
 *
 * All calls are sent to the observability server for tracking.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type TSchema } from "@sinclair/typebox";
import { spawn } from "child_process";
import { WebSocket } from "ws";
import { createLogger, setSessionId, type ErrorCode } from "../../lib/logger/logger.js";

const logger = createLogger("memory");

// Configuration
interface MemoryConfig {
  venvPython: string;
  bridgePath: string;
  observabilityUrl: string;
  observabilityApiKey: string;
  enableObservability: boolean;
}

let config: MemoryConfig;

// Observability state
let observabilityWs: WebSocket | null = null;
let sessionId: string = "";
let observabilityConnected = false;

function connectObservability(): void {
  if (!config.enableObservability) return;
  try {
    const url = new URL(config.observabilityUrl);
    if (config.observabilityApiKey) {
      url.searchParams.set("apiKey", config.observabilityApiKey);
    }
    observabilityWs = new WebSocket(url.toString());
    observabilityWs.on("open", () => {
      observabilityConnected = true;

      // Don't let this connection prevent the Node.js process from exiting.
      // When Pi's print mode completes an agent, it sets process.exitCode and
      // returns from main(). The process should exit when the event loop drains.
      // Without unref(), this TCP socket keeps the event loop alive indefinitely,
      // preventing agent subprocesses from ever exiting.
      // `ws` exposes the underlying net.Socket as an untyped internal `_socket`.
      const socket = (observabilityWs as unknown as { _socket?: { unref?: () => void } })._socket;
      socket?.unref?.();
    });
    observabilityWs.on("close", () => {
      observabilityConnected = false;
      // Don't let reconnect timers prevent the Node.js process from exiting.
      const timer = setTimeout(connectObservability, 5000);
      timer.unref();
    });
    observabilityWs.on("error", () => {
      observabilityConnected = false;
    });
  } catch {
    logger.debug("Observability connection failed", { url: config.observabilityUrl });
  }
}

function emitObservability(event: string, data: Record<string, unknown>): void {
  if (!config.enableObservability || !observabilityConnected || !observabilityWs) return;
  try {
    observabilityWs.send(
      JSON.stringify({ event: `memory_${event}`, sessionId, timestamp: Date.now(), data })
    );
  } catch {
    logger.debug("Observability emit failed", { tool: event, data });
  }
}

// ── Bridge resilience ──────────────────────────────────────────────────
// The bridge is a fresh Python process per call that opens ChromaDB + the
// embedding model. Under heavy whole-system load it was observed to die
// intermittently by SIGNAL during startup (Node reports exit code `null`, empty
// stderr) — a native crash / OOM / kill, not a clean error. Durable memory is a
// protected capability, so such a transient death is retried rather than
// silently dropping the operation.
const BRIDGE_TIMEOUT_MS = 30000; // 30s — prevent infinite hangs from ChromaDB lock contention
const MAX_BRIDGE_ATTEMPTS = 3; // 1 initial + up to 2 retries

/**
 * A bridge process killed by a SIGNAL (Node reports `code === null` / a non-null
 * `signal`) is a transient native crash worth retrying. A clean non-zero exit
 * (the bridge ran and reported an error) is terminal — retrying won't change it.
 */
export function isRetryableBridgeExit(code: number | null, signal: NodeJS.Signals | null): boolean {
  return code === null || signal !== null;
}

/** Backoff (ms) before retry attempt N (0-based): 150ms, then 400ms. */
export function bridgeRetryBackoffMs(attempt: number): number {
  return [150, 400][attempt] ?? 400;
}

/**
 * Run `fn` with bounded retry. Retries only when `isRetryable(err)` is true, up
 * to `maxAttempts` total, sleeping `backoffMs(attempt)` between tries. Pure of
 * any bridge/IO specifics so the retry BEHAVIOR is unit-testable.
 */
export async function retryTransient<T>(
  fn: (attempt: number) => Promise<T>,
  opts: {
    maxAttempts: number;
    isRetryable: (err: unknown) => boolean;
    backoffMs: (attempt: number) => number;
    onRetry?: (attempt: number, backoffMs: number, err: unknown) => void;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!opts.isRetryable(err) || attempt === opts.maxAttempts - 1) break;
      const b = opts.backoffMs(attempt);
      opts.onRetry?.(attempt, b, err);
      await sleep(b);
    }
  }
  throw lastErr;
}

/** One bridge invocation. Rejects with `retryable` set on transient failures. */
function callBridgeOnce(
  tool: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const request = JSON.stringify({ tool, params });
    const proc = spawn(config.venvPython, [config.bridgePath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    // Timeout guard — kills the process if it hangs
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGKILL");
        logger.error(
          "Bridge timeout",
          { tool, duration: "30s" },
          Object.assign(
            new Error(`Bridge timed out after ${BRIDGE_TIMEOUT_MS}ms (tool: ${tool})`),
            { code: "BRIDGE_TIMEOUT" as const }
          )
        );
        reject(new Error(`Bridge timed out after ${BRIDGE_TIMEOUT_MS}ms (tool: ${tool})`));
      }
    }, BRIDGE_TIMEOUT_MS);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return; // Already rejected by timeout
      settled = true;
      if (code !== 0) {
        const retryable = isRetryableBridgeExit(code, signal);
        const sigNote = signal ? ` (signal ${signal})` : "";
        logger.error(
          "Bridge exited with non-zero code",
          { tool, exitCode: code, signal, retryable },
          Object.assign(new Error(`Bridge exited with code ${code}${sigNote}: ${stderr}`), {
            code: "BRIDGE_EXIT_CODE" as const,
          })
        );
        reject(
          Object.assign(new Error(`Bridge exited with code ${code}${sigNote}: ${stderr}`), {
            code: "BRIDGE_EXIT_CODE" as const,
            retryable,
          })
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        logger.warn(
          "Bridge response parse error",
          { tool, exitCode: code, stderr: stderr.slice(0, 300) },
          Object.assign(new Error(`Failed to parse: ${stdout}`), {
            code: "BRIDGE_PARSE_ERROR" as const,
          })
        );
        reject(
          Object.assign(new Error(`Failed to parse: ${stdout}`), {
            code: "BRIDGE_PARSE_ERROR" as const,
            retryable: false,
          })
        );
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        logger.error(
          "Bridge spawn failed",
          { tool },
          Object.assign(err, { code: "BRIDGE_SPAWN_ERROR" as const })
        );
        reject(Object.assign(err, { code: "BRIDGE_SPAWN_ERROR" as const, retryable: true }));
      }
    });
    // Wait for spawn to complete before writing stdin (prevents race on cold starts)
    proc.on("spawn", () => {
      proc.stdin.write(request);
      proc.stdin.end();
    });
  });
}

/**
 * Call the memory bridge with bounded retry on transient (signal-kill / spawn)
 * failures. The observed intermittent deaths occur during bridge *startup*
 * (before the request is read/applied), so a retry does not re-run a partial
 * write. Terminal failures (clean error exit, parse error, timeout) are not
 * retried.
 */
async function callBridge(
  tool: string,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  return retryTransient((_attempt) => callBridgeOnce(tool, params), {
    maxAttempts: MAX_BRIDGE_ATTEMPTS,
    isRetryable: (err) => (err as { retryable?: boolean } | null)?.retryable === true,
    backoffMs: bridgeRetryBackoffMs,
    onRetry: (attempt, backoffMs, err) =>
      logger.warn("Bridge transient failure — retrying", {
        tool,
        attempt: attempt + 1,
        maxAttempts: MAX_BRIDGE_ATTEMPTS,
        backoffMs,
        error: err instanceof Error ? err.message : String(err),
      }),
  });
}

function formatResult(result: Record<string, unknown>): string {
  if (result.error) return `❌ Error: ${result.error}`;
  if (result.success === false) return `⚠️ ${result.reason || result.error || "Operation failed"}`;
  return "✅\n" + JSON.stringify(result, null, 2);
}

function createTool(
  name: string,
  description: string,
  promptSnippet: string,
  promptGuidelines: string[],
  parameters: Record<string, TSchema>,
  handler: (params: Record<string, unknown>) => Promise<Record<string, unknown>>
) {
  return {
    name: `memory_${name}`,
    label: `Memory: ${name.replace(/_/g, " ")}`,
    description,
    promptSnippet,
    promptGuidelines,
    parameters: Type.Object(parameters),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: (update: string) => void,
      _ctx?: unknown
    ) {
      const startTime = Date.now();
      try {
        const result = await handler(params);
        emitObservability("tool_call", {
          tool: name,
          params,
          result,
          elapsed: Date.now() - startTime,
          success: !result.error && result.success !== false,
        });
        return {
          content: [{ type: "text" as const, text: formatResult(result) }],
          details: result,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errCode =
          error instanceof Error ? (error as Error & { code?: ErrorCode }).code : undefined;
        logger.error(
          "Tool execution failed",
          { tool: name, params, elapsed: Date.now() - startTime },
          Object.assign(new Error(errorMessage), { code: errCode ?? "BRIDGE_EXIT_CODE" })
        );
        emitObservability("tool_error", {
          tool: name,
          params,
          error: errorMessage,
          elapsed: Date.now() - startTime,
        });
        return {
          content: [{ type: "text" as const, text: `❌ Error: ${errorMessage}` }],
          isError: true,
        };
      }
    },
  };
}

// ============================================
// PALACE READ TOOLS - KNOW WHAT'S STORED
// ============================================

const toolStatus = createTool(
  "status",
  "Get the palace overview: total drawers, wings, rooms. Call this first to understand what information is available in memory.",
  "Check palace status to see stored memories",
  [
    "Call memory_status at session start to load context.",
    "Use memory_status before memory_search to understand the palace structure.",
  ],
  {},
  async () => callBridge("status")
);

const toolListWings = createTool(
  "list_wings",
  "List all wings (projects, people, topics) with their drawer counts. Use this to discover what categories exist in memory.",
  "List all memory wings (projects, people, topics)",
  ["Use memory_list_wings to discover available wings before searching."],
  {},
  async () => callBridge("list_wings")
);

const toolListRooms = createTool(
  "list_rooms",
  "List rooms (topics) within a wing or all rooms. Use this to see what topics are stored.",
  "List memory rooms (topics) within wings",
  ["Use memory_list_rooms to find specific topics within a wing."],
  {
    wing: Type.Optional(
      Type.String({
        description: "Wing name to list rooms for (e.g., 'penny'). Omit to list all rooms.",
      })
    ),
  },
  async (params) => callBridge("list_rooms", params)
);

const toolGetTaxonomy = createTool(
  "get_taxonomy",
  "Get the complete hierarchy: wing → room → drawer count. Use this for a full overview of memory structure.",
  "Show complete memory hierarchy",
  ["Use memory_get_taxonomy for a bird's-eye view of all stored memories."],
  {},
  async () => callBridge("get_taxonomy")
);

const toolSearch = createTool(
  "search",
  "Semantic search across all memories. Returns verbatim content with similarity scores. ALWAYS search before answering questions about people, projects, decisions, or past conversations.",
  "Search memories for information from past sessions",
  [
    "Before answering questions about people, projects, or decisions, call memory_search first.",
    "Use memory_search to find context from previous conversations.",
    "Never guess about past discussions - search memory instead.",
  ],
  {
    query: Type.String({ description: "What to search for. Use natural language." }),
    limit: Type.Optional(
      Type.Number({ description: "Max results (1-20, default 5)", minimum: 1, maximum: 20 })
    ),
    wing: Type.Optional(Type.String({ description: "Filter to wing (e.g., 'penny')" })),
    room: Type.Optional(Type.String({ description: "Filter to room (e.g., 'decisions')" })),
  },
  // track_recall: this is model-initiated recall, so record usage (feeds the
  // archiver's recall-modulated TTL + ranking). System queries do not set this.
  async (params) => callBridge("search", { ...params, track_recall: true })
);

const toolSmartSearch = createTool(
  "smart_search",
  "Context-aware memory search that minimizes context usage. Returns summaries with relevance filtering. Use for efficient retrieval.",
  "Smart search for context-efficient memory retrieval",
  [
    "Use memory_smart_search instead of memory_search for context-efficient retrieval.",
    "Smart search returns summaries (truncated content) not full text.",
    "Default limit is 3 (vs 5 for regular search) and min_similarity is 0.25.",
    "Retrieval is semantic over all rooms unless you pass an explicit wing/room filter.",
    "Set include_full=true if you need complete content after reviewing summaries.",
  ],
  {
    query: Type.String({ description: "What to search for. Use natural language." }),
    context: Type.Optional(
      Type.String({ description: "Additional context to help find relevant results" })
    ),
    limit: Type.Optional(
      Type.Number({ description: "Max results (1-10, default 3)", minimum: 1, maximum: 10 })
    ),
    wing: Type.Optional(Type.String({ description: "Filter to wing (e.g., 'penny')" })),
    room: Type.Optional(Type.String({ description: "Filter to room (e.g., 'decisions')" })),
    min_similarity: Type.Optional(
      Type.Number({
        description:
          "Minimum similarity threshold 0-1 (default: 0.25). Lower = more results. Uses L2-to-similarity scale: 1/(1+dist).",
        minimum: 0,
        maximum: 1,
      })
    ),
    include_full: Type.Optional(
      Type.Boolean({ description: "Include full content instead of summary (default: false)" })
    ),
  },
  async (params) => callBridge("smart_search", { ...params, track_recall: true })
);

const toolCheckDuplicate = createTool(
  "check_duplicate",
  "Check if content already exists before adding. Use this to avoid storing duplicate information.",
  "Check if content already exists in memory",
  ["Call memory_check_duplicate before memory_add_drawer to avoid duplicates."],
  {
    content: Type.String({ description: "Content to check for duplicates" }),
    threshold: Type.Optional(
      Type.Number({
        description: "Similarity threshold 0-1 (default: 0.9)",
        minimum: 0,
        maximum: 1,
      })
    ),
  },
  async (params) => callBridge("check_duplicate", params)
);

const toolGetAaakSpec = createTool(
  "get_aaak_spec",
  "Get the AAAK dialect specification for compressed diary entries. Use this to learn the memory format.",
  "Get AAAK specification for diary format",
  ["Call memory_get_aaak_spec before writing diary entries to learn the format."],
  {},
  async () => callBridge("get_aaak_spec")
);

// ============================================
// PALACE WRITE TOOLS - STORE INFORMATION
// ============================================

// ============================================
// PALACE BULK TOOLS - ENUMERATION & CLEANUP
// ============================================

const toolListDrawers = createTool(
  "list_drawers",
  "List drawer IDs and metadata, filtered by wing and/or room. Use for bulk operations and cleanup.",
  "List drawer IDs in a specific wing/room",
  [
    "Use memory_list_drawers to enumerate all drawers in a room before bulk operations.",
    "Returns drawer IDs, wing, room, and source_file metadata.",
  ],
  {
    wing: Type.Optional(Type.String({ description: "Filter by wing name" })),
    room: Type.Optional(Type.String({ description: "Filter by room name" })),
    limit: Type.Optional(
      Type.Number({ description: "Max results (default 1000)", minimum: 1, maximum: 10000 })
    ),
  },
  async (params) => callBridge("list_drawers", params)
);

const toolDeleteDrawersByRoom = createTool(
  "delete_drawers_by_room",
  "Bulk delete all drawers in a specific wing/room combination. IRREVERSIBLE. Use for cleanup of noise rooms.",
  "Bulk delete all drawers in a wing/room",
  [
    "IRREVERSIBLE — deleted drawers cannot be recovered.",
    "Requires BOTH wing AND room to prevent accidental full-wing deletion.",
    "Use memory_list_drawers first to verify what will be deleted.",
  ],
  {
    wing: Type.String({ description: "Wing name (required)" }),
    room: Type.String({ description: "Room name (required)" }),
  },
  async (params) => callBridge("delete_drawers_by_room", params)
);

const toolAddDrawer = createTool(
  "add_drawer",
  "Store verbatim content in the palace. Use this to save decisions, conversations, code snippets, or any information worth remembering for future sessions.",
  "Store information in memory for future reference",
  [
    "After making decisions, call memory_add_drawer to store the rationale.",
    "Store verbatim content - exact words, not summaries.",
    "Use descriptive room names: 'decisions', 'architecture', 'sessions'.",
  ],
  {
    wing: Type.String({
      description:
        "Wing name. Use 'penny' (Penny's main wing) with a room like 'decisions'/'user'/'architecture'; dedicated skill wings are 'wing_<skill>' (e.g. 'wing_jsa'). Prefer 'penny' + a room over creating new top-level wings.",
    }),
    room: Type.String({ description: "Room name (e.g., 'decisions', 'architecture', 'sessions')" }),
    content: Type.String({
      description: "Verbatim content to store - include who/when/why context",
    }),
    source_file: Type.Optional(Type.String({ description: "Source file if applicable" })),
    added_by: Type.Optional(Type.String({ description: "Agent name (default: 'penny')" })),
  },
  async (params) => callBridge("add_drawer", params)
);

const toolDeleteDrawer = createTool(
  "delete_drawer",
  "Delete a drawer by ID. Use to remove outdated or incorrect information. This is irreversible.",
  "Delete a memory entry by ID",
  ["Only use memory_delete_drawer when information is proven wrong."],
  {
    drawer_id: Type.String({ description: "ID of drawer to delete" }),
  },
  async (params) => callBridge("delete_drawer", params)
);

// ============================================
// KNOWLEDGE GRAPH - ENTITY RELATIONSHIPS
// ============================================

const toolKgQuery = createTool(
  "kg_query",
  "Query the knowledge graph for entity relationships. Use this to find facts about people, projects, or topics. Call before making assumptions about entities.",
  "Query knowledge graph for entity relationships",
  [
    "Before assuming facts about entities, call memory_kg_query to verify.",
    "Use memory_kg_query to find what X works_on, uses, prefers, or decided.",
  ],
  {
    entity: Type.String({
      description: "Entity to query (e.g., 'Penny', 'User', 'auth-migration')",
    }),
    as_of: Type.Optional(
      Type.String({ description: "Date filter YYYY-MM-DD - facts valid at that date" })
    ),
    direction: Type.Optional(
      Type.String({ description: "'outgoing' (entity→?), 'incoming' (?→entity), or 'both'" })
    ),
  },
  async (params) => callBridge("kg_query", params)
);

const toolKgAdd = createTool(
  "kg_add",
  "Add a fact to the knowledge graph. Use this to store relationships like 'X works_on Y' or 'User prefers dark_mode'.",
  "Add a relationship fact to the knowledge graph",
  [
    "After learning new facts, call memory_kg_add to store the relationship.",
    "Use canonical predicates (see docs/agents/memory/kg-patterns.md): completed, decided, produced, works_on, uses, prefers, plus lifecycle predicates like verified_by/fixes.",
  ],
  {
    subject: Type.String({ description: "Entity doing/being something (e.g., 'User', 'Penny')" }),
    predicate: Type.String({
      description:
        "Canonical predicate (see kg-patterns.md): e.g. completed, decided, produced, works_on, uses, prefers, verified_by, fixes",
    }),
    object: Type.String({ description: "Related entity (e.g., 'MemPalace', 'auth-migration')" }),
    valid_from: Type.Optional(Type.String({ description: "When this became true (YYYY-MM-DD)" })),
    source_closet: Type.Optional(Type.String({ description: "Drawer ID where this fact appears" })),
  },
  async (params) => callBridge("kg_add", params)
);

const toolKgInvalidate = createTool(
  "kg_invalidate",
  "Mark a fact as no longer true. Use when relationships change or decisions are reversed.",
  "Mark a knowledge graph fact as ended",
  [
    "When facts change, call memory_kg_invalidate on the old fact.",
    "After invalidating, add the new fact with memory_kg_add.",
  ],
  {
    subject: Type.String({ description: "Subject entity" }),
    predicate: Type.String({ description: "Relationship type" }),
    object: Type.String({ description: "Object entity" }),
    ended: Type.Optional(Type.String({ description: "End date YYYY-MM-DD (default: today)" })),
  },
  async (params) => callBridge("kg_invalidate", params)
);

const toolKgTimeline = createTool(
  "kg_timeline",
  "Get chronological timeline of facts. Use this to understand how a project or entity evolved over time.",
  "Show chronological timeline of facts for entity",
  ["Use memory_kg_timeline to understand project history and changes."],
  {
    entity: Type.Optional(
      Type.String({ description: "Entity to get timeline for. Omit for all entities." })
    ),
  },
  async (params) => callBridge("kg_timeline", params)
);

const toolKgStats = createTool(
  "kg_stats",
  "Get knowledge graph statistics: entity count, triple count, relationship types.",
  "Show knowledge graph statistics",
  ["Call memory_kg_stats to understand scope of stored knowledge."],
  {},
  async () => callBridge("kg_stats")
);

// ============================================
// NAVIGATION - EXPLORE CONNECTIONS
// ============================================

const toolTraverse = createTool(
  "traverse",
  "Walk the palace graph from a room. Shows connected ideas across wings - follow threads through the palace.",
  "Traverse connections from a room",
  ["Use memory_traverse to discover related topics."],
  {
    start_room: Type.String({ description: "Starting room (e.g., 'auth', 'architecture')" }),
    max_hops: Type.Optional(
      Type.Number({ description: "Max hops (1-5, default 2)", minimum: 1, maximum: 5 })
    ),
  },
  async (params) => callBridge("traverse", params)
);

const toolFindTunnels = createTool(
  "find_tunnels",
  "Find rooms that bridge two wings - shared topics connecting different domains.",
  "Find shared topics between wings",
  ["Use memory_find_tunnels to discover cross-project connections."],
  {
    wing_a: Type.Optional(Type.String({ description: "First wing" })),
    wing_b: Type.Optional(Type.String({ description: "Second wing" })),
  },
  async (params) => callBridge("find_tunnels", params)
);

const toolGraphStats = createTool(
  "graph_stats",
  "Get palace graph statistics: total rooms, tunnel connections, edges between wings.",
  "Show palace connectivity statistics",
  ["Call memory_graph_stats to understand memory network structure."],
  {},
  async () => callBridge("graph_stats")
);

// ============================================
// AGENT DIARY - SESSION NOTES
// ============================================

const toolDiaryWrite = createTool(
  "diary_write",
  "Write an entry to your agent diary. Use this at END of every session to record what happened. AAAK format: SESSION:YYYY-MM-DD|topic|key_points|importance★",
  "Write diary entry for session record",
  [
    "At END of every session, call memory_diary_write to record what happened.",
    "Use AAAK format: SESSION:YYYY-MM-DD|what.done|key.insights|★★★",
    "Importance: ★ (minor) to ★★★★★ (critical).",
  ],
  {
    agent_name: Type.String({ description: "Your agent name (use 'penny' for main agent)" }),
    entry: Type.String({
      description: "Diary entry in AAAK format: SESSION:YYYY-MM-DD|topic|key_points|★★★",
    }),
    topic: Type.Optional(Type.String({ description: "Topic tag (default: 'general')" })),
  },
  async (params) => callBridge("diary_write", params)
);

const toolDiaryRead = createTool(
  "diary_read",
  "Read your recent diary entries. Call this at START of session to load context from previous sessions.",
  "Read recent diary entries for context",
  [
    "At START of session, call memory_diary_read to load previous context.",
    "Use memory_diary_read to recall what past sessions recorded.",
  ],
  {
    agent_name: Type.String({ description: "Agent name to read (use 'penny' for main)" }),
    last_n: Type.Optional(
      Type.Number({ description: "Entries to read (1-50, default 10)", minimum: 1, maximum: 50 })
    ),
  },
  async (params) => callBridge("diary_read", params)
);

// ============================================
// SIGNAL LIFECYCLE
// ============================================

const toolAcknowledgeSignal = createTool(
  "acknowledge_signal",
  "Acknowledge a pending ambient signal so it stops re-surfacing at session start. Call this once you have addressed (or consciously dismissed) a signal shown in the session-memory brief.",
  "Acknowledge a pending signal to retire it",
  [
    "When you have addressed a pending signal, call memory_acknowledge_signal with its signal_id so it is not shown again.",
    "signal_ids look like 'signal_YYYY-MM-DD_NNN_source'.",
  ],
  {
    signal_id: Type.String({
      description: "The signal_id to acknowledge (from the session brief)",
    }),
    session_id: Type.Optional(Type.String({ description: "Current session id (optional)" })),
  },
  async (params) => callBridge("acknowledge_signal", params)
);

// ============================================
// AUTO-DIARY HELPERS
// ============================================

// Shape of the observability REST `/sessions/:id/entries` response we consume.
interface ObservabilityEntry {
  data?: { toolName?: string };
}
interface ObservabilityEntriesResponse {
  items: ObservabilityEntry[];
  total?: number;
}

function isEntriesResponse(value: unknown): value is ObservabilityEntriesResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { items?: unknown }).items)
  );
}

export async function observabilityRestFetch(url: string, apiKey: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) {
      // Observability REST auth is Bearer-only (apps/observability/.../main.py
      // require_auth via HTTPBearer). Sending x-api-key here 401'd every
      // auto-diary fetch, silently disabling the only automatic capture path.
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function buildDiaryFromObservability(
  sessionId: string,
  reason: string,
  observabilityUrl: string,
  observabilityApiKey: string
): Promise<string | null> {
  const today = new Date().toISOString().split("T")[0];
  const restBase = observabilityUrl.replace(/^ws/, "http").replace(/\/ws$/, "");

  const agentsUrl = `${restBase}/sessions/${encodeURIComponent(
    sessionId
  )}/entries?event_type=agent_start&limit=500`;
  const toolsUrl = `${restBase}/sessions/${encodeURIComponent(
    sessionId
  )}/entries?event_type=tool_execution_start&limit=500`;

  const [agentsResp, toolsResp] = await Promise.all([
    observabilityRestFetch(agentsUrl, observabilityApiKey),
    observabilityRestFetch(toolsUrl, observabilityApiKey),
  ]);

  if (!isEntriesResponse(agentsResp) || !isEntriesResponse(toolsResp)) {
    return null;
  }

  const agentCount =
    typeof agentsResp.total === "number" ? agentsResp.total : agentsResp.items.length;

  // Count tool executions by toolName, sort descending, take top 6
  const toolCounts: Record<string, number> = {};
  for (const entry of toolsResp.items) {
    const toolName = entry.data?.toolName;
    if (toolName) {
      toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
    }
  }

  const topTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => `${name}(${count})`)
    .join("+");

  const toolsSummary = topTools || "none";
  const entry = `SESSION:${today}|session-end|Agents:${agentCount}. Tools:${toolsSummary}. Reason:${reason}|★★`;
  return entry;
}

// ============================================
// EXTENSION EXPORT
// ============================================

// Minimal shapes of the Pi runtime objects this extension actually touches.
// The SDK's ExtensionAPI is untyped, so we describe only what we use.
interface SessionStartContext {
  sessionManager: { getSessionId(): string };
}
interface CommandContext {
  ui: { notify(message: string, level: string): void };
}
interface SessionShutdownEvent {
  reason?: string;
}

export default function memoryExtension(pi: ExtensionAPI) {
  config = {
    venvPython:
      process.env.PI_VENV_PYTHON || `${process.env.PROJECT_ROOT || process.cwd()}/.venv/bin/python`,
    bridgePath:
      process.env.PI_MEMORY_BRIDGE ||
      `${process.env.PROJECT_ROOT || process.cwd()}/scripts/system/bridge/memory_bridge.py`,
    observabilityUrl: process.env.PI_OBSERVABILITY_URL || "ws://localhost:8765/ws",
    observabilityApiKey: process.env.PI_OBSERVABILITY_API_KEY || "",
    enableObservability: process.env.PI_OBSERVABILITY_ENABLED !== "false",
  };

  connectObservability();

  pi.on("session_start", async (_event: unknown, ctx: SessionStartContext) => {
    sessionId = ctx.sessionManager.getSessionId();
    setSessionId(sessionId);
  });

  // Register all tools
  pi.registerTool(toolStatus);
  pi.registerTool(toolListWings);
  pi.registerTool(toolListRooms);
  pi.registerTool(toolGetTaxonomy);
  pi.registerTool(toolSearch);
  pi.registerTool(toolSmartSearch);
  pi.registerTool(toolCheckDuplicate);
  pi.registerTool(toolGetAaakSpec);
  pi.registerTool(toolListDrawers);
  pi.registerTool(toolDeleteDrawersByRoom);
  pi.registerTool(toolAddDrawer);
  pi.registerTool(toolDeleteDrawer);
  pi.registerTool(toolKgQuery);
  pi.registerTool(toolKgAdd);
  pi.registerTool(toolKgInvalidate);
  pi.registerTool(toolKgTimeline);
  pi.registerTool(toolKgStats);
  pi.registerTool(toolTraverse);
  pi.registerTool(toolFindTunnels);
  pi.registerTool(toolGraphStats);
  pi.registerTool(toolDiaryWrite);
  pi.registerTool(toolDiaryRead);
  pi.registerTool(toolAcknowledgeSignal);

  // Commands
  pi.registerCommand("memory-init", {
    description: "Initialize the memory palace for Penny",
    handler: async (_args: string, ctx: CommandContext) => {
      ctx.ui.notify("Initializing memory palace...", "info");
      const result = await callBridge("status");
      if (result.error && result.error.toString().includes("No palace found")) {
        ctx.ui.notify("Run 'mempalace init ~/projects/penny' in terminal first", "warning");
      } else {
        ctx.ui.notify(`Memory palace ready: ${result.total_drawers || 0} drawers`, "success");
      }
    },
  });

  pi.registerCommand("memory-status", {
    description: "Show memory palace status",
    handler: async (_args: string, ctx: CommandContext) => {
      const result = await callBridge("status");
      if (result.error) {
        ctx.ui.notify(`Memory error: ${result.error}`, "error");
      } else {
        const wings = (result.wings as Record<string, number>) || {};
        const wingCount = Object.keys(wings).length;
        ctx.ui.notify(`Memory: ${result.total_drawers} drawers, ${wingCount} wings`, "info");
      }
    },
  });

  pi.on("session_shutdown", async (event: SessionShutdownEvent) => {
    emitObservability("session_end", { summary: "Session ended" });

    const reason = event?.reason || "unknown";
    try {
      const diaryEntry = await buildDiaryFromObservability(
        sessionId,
        reason,
        config.observabilityUrl,
        config.observabilityApiKey
      );
      if (diaryEntry) {
        await callBridge("diary_write", {
          agent_name: "penny",
          entry: diaryEntry,
          topic: "session-end",
          session_id: sessionId,
        });
        logger.info("Auto-diary written", { sessionId, entry: diaryEntry });
      } else {
        logger.warn("Auto-diary skipped", {
          sessionId,
          reason: "observability fetch returned null",
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("Auto-diary failed", { sessionId, error: message });
    }

    if (observabilityWs) {
      observabilityWs.close();
    }
  });
}
