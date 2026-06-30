/**
 * Observability Extension
 *
 * Captures Pi conversation messages and sends them to an observability
 * WebSocket server for real-time tracking and analysis.
 *
 * Captures:
 * - Session lifecycle (start/shutdown)
 * - Agent lifecycle (start/end)
 * - Messages (user, assistant, toolResult) - complete content at message_end
 * - Tool execution (start, result)
 * - Model changes (model_select)
 *
 * Configuration (via .env or environment):
 * - PI_OBSERVABILITY_URL: WebSocket URL (default: ws://localhost:8765/ws)
 * - PI_OBSERVABILITY_API_KEY: API key for authentication
 * - PI_OBSERVABILITY_ENABLED: Enable/disable extension (default: true)
 * - PI_OBSERVABILITY_MAX_OUTPUT_LENGTH: Max tool output length (default: 10000)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import WebSocket from "ws";
import { createLogger, setSessionId, setGlobalLogTransport } from "../../lib/logger/logger.js";
import { Type } from "@sinclair/typebox";

const logger = createLogger("observability");

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

// Configuration
interface ObservabilityConfig {
  url: string;
  apiKey: string;
  enabled: boolean;
  autoStart: boolean;
  maxOutputLength: number;
  reconnectDelay: number;
  maxReconnectDelay: number;
  bufferSize: number;
}

let config: ObservabilityConfig;

// Types
interface ObservabilityMessage {
  event: string;
  sessionId: string;
  timestamp: number;
  data: unknown;
}

interface QueuedMessage {
  message: ObservabilityMessage;
  attempts: number;
}

interface ConnectionState {
  ws: WebSocket | null;
  connected: boolean;
  reconnectAttempts: number;
  reconnectTimer: NodeJS.Timeout | null;
}

// State
const state: ConnectionState = {
  ws: null,
  connected: false,
  reconnectAttempts: 0,
  reconnectTimer: null,
};

let messageQueue: QueuedMessage[] = [];
let sessionId: string = "";
let sessionStartTime: number = 0;

/**
 * Truncate text to max length, adding ellipsis
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...[truncated]";
}

/**
 * Filter and truncate content blocks
 * - Removes binary image data
 * - Truncates text to max length
 */
function filterContentBlocks(content: unknown, maxOutputLength: number): unknown {
  if (!content) return content;

  // Handle string content
  if (typeof content === "string") {
    return truncateText(content, maxOutputLength);
  }

  // Handle array of content blocks
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (!block || typeof block !== "object") return block;

      // Skip image content entirely (just indicate it was filtered)
      if (block.type === "image") {
        return { type: "image", mimeType: block.mimeType || "unknown", filtered: true };
      }

      // Truncate text content
      if (block.type === "text" && typeof block.text === "string") {
        return { ...block, text: truncateText(block.text, maxOutputLength) };
      }

      // Truncate thinking content
      if (block.type === "thinking" && typeof block.thinking === "string") {
        return { ...block, thinking: truncateText(block.thinking, maxOutputLength) };
      }

      // Pass through other blocks (toolCall, etc.)
      return block;
    });
  }

  return content;
}

/**
 * Create WebSocket connection
 */
function connect(force = false): void {
  if (state.ws) {
    if (!force && state.ws.readyState === WebSocket.OPEN) {
      return; // Already healthy
    }
    state.ws.close();
  }

  const url = new URL(config.url);

  try {
    const ws = new WebSocket(url.toString(), {
      headers: {
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
    });

    state.ws = ws;

    ws.on("open", () => {
      state.connected = true;
      state.reconnectAttempts = 0;
      flushQueue();

      // Wire shared logger to send structured log entries via this WebSocket
      setGlobalLogTransport((entry) => {
        try {
          if (!state.connected || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
            return; // silently drop — no recursion
          }
          const data = JSON.parse(entry);
          const message = {
            event: "log",
            sessionId: getSessionId(),
            timestamp: Date.now(),
            data,
          };
          state.ws.send(JSON.stringify(message));
        } catch {
          // Ignore transport failures to avoid recursive logging
        }
      });

      // Don't let this connection prevent the Node.js process from exiting.
      // When Pi's print mode completes an agent, it sets process.exitCode and
      // returns from main(). The process should exit when the event loop drains.
      // Without unref(), this TCP socket keeps the event loop alive indefinitely,
      // preventing agent subprocesses from ever exiting.
      const socket = (ws as any)._socket as { unref?: () => void } | undefined;
      socket?.unref?.();
    });

    ws.on("message", (data) => {
      try {
        const _msg = JSON.parse(data.toString());
        // Server welcome acknowledged
      } catch {
        logger.debug("Observability message parse error ignored");
      }
    });

    ws.on("close", (code, reason) => {
      if (state.ws !== ws) return; // Ignore stale events from replaced sockets
      setGlobalLogTransport(undefined);
      if (state.connected) {
        logger.info("WebSocket closed, reconnecting", { code, reason: reason?.toString() });
      } else {
        logger.debug("WebSocket closed during connection attempt", { code, reason: reason?.toString() });
      }
      state.connected = false;
      state.ws = null;
      scheduleReconnect();
    });

    ws.on("error", (error) => {
      if (state.ws !== ws) return; // Ignore stale events from replaced sockets
      setGlobalLogTransport(undefined);
      if (state.connected) {
        logger.error(
          "WebSocket error",
          { error: error instanceof Error ? error.message : String(error) },
          Object.assign(new Error(String(error)), { code: "OBSERVABILITY_WS_ERROR" })
        );
      } else {
        logger.debug("WebSocket connection attempt failed, will retry", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      state.connected = false;
      state.ws = null;
      scheduleReconnect();
    });
  } catch (_error) {
    logger.debug("Observability WebSocket connection failed, scheduling reconnect", {
      error: String(_error),
    });
    scheduleReconnect();
  }
}

/**
 * Schedule reconnection with exponential backoff
 */
function scheduleReconnect(): void {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
  }

  const delay = Math.min(
    config.reconnectDelay * Math.pow(2, state.reconnectAttempts),
    config.maxReconnectDelay
  );

  state.reconnectAttempts++;

  state.reconnectTimer = setTimeout(() => {
    connect();
  }, delay);

  // Don't let reconnect timers prevent the Node.js process from exiting.
  // Without unref(), this timer keeps the event loop alive even when the
  // agent subprocess has completed its work, preventing proc.on("close")
  // from ever firing in the parent process.
  state.reconnectTimer.unref();
}

/**
 * Send message to server or queue if disconnected
 */
function sendMessage(event: string, data: unknown): void {
  if (!config.enabled) return;

  const message: ObservabilityMessage = {
    event,
    sessionId,
    timestamp: Date.now(),
    data,
  };

  if (state.connected && state.ws?.readyState === WebSocket.OPEN) {
    sendImmediately(message);
  } else {
    queueMessage(message);
  }
}

/**
 * Send message immediately
 */
function sendImmediately(message: ObservabilityMessage): void {
  try {
    state.ws?.send(JSON.stringify(message));
  } catch (_error) {
    logger.debug("Observability send immediately failed, queuing message", {
      error: String(_error),
    });
    queueMessage(message);
  }
}

/**
 * Queue message for later delivery
 */
function queueMessage(message: ObservabilityMessage): void {
  if (messageQueue.length >= config.bufferSize) {
    logger.warn(
      "Message queue overflow, dropping oldest",
      { queueSize: config.bufferSize },
      Object.assign(new Error("Queue overflow"), { code: "OBSERVABILITY_QUEUE_OVERFLOW" })
    );
    messageQueue.shift();
  }
  messageQueue.push({ message, attempts: 0 });
}

/**
 * Flush queued messages
 */
function flushQueue(): void {
  if (messageQueue.length === 0) return;

  const queue = [...messageQueue];
  messageQueue = [];

  for (const queued of queue) {
    if (state.connected && state.ws?.readyState === WebSocket.OPEN) {
      sendImmediately(queued.message);
    } else {
      messageQueue.push(queued);
    }
  }
}

/**
 * Get current model info
 */
// D1: Null-safe model info extraction with diagnostic logging.
// model.provider can be null even when model exists — use optional chaining.
function getModelInfo(ctx: ExtensionAPI): { provider: string; model: string } | null {
  try {
    const model = ctx.model;
    if (!model) return null;

    const provider = model.provider?.id;
    const modelId = model.id;

    // Diagnostic: log when model exists but provider is missing
    if (!provider && modelId) {
      logger.warn(
        "Model provider is null despite model being present — session will have partial model info",
        { modelId, modelProviderType: typeof model.provider },
        Object.assign(new Error("Null model provider"), {
          code: "OBSERVABILITY_NULL_MODEL_PROVIDER",
        })
      );
    }

    return {
      provider: provider || "unknown",
      model: modelId || "unknown",
    };
  } catch (err: any) {
    logger.warn("Failed to extract model info", {
      error: err?.message || String(err),
    });
    return null;
  }
}

/**
 * Extract relevant data from a message for observability
 */
function extractMessageData(msg: any, maxOutputLength: number): Record<string, unknown> {
  const data: Record<string, unknown> = {
    role: msg.role,
    timestamp: msg.timestamp,
  };

  if (msg.role === "user") {
    data.content = filterContentBlocks(msg.content, maxOutputLength);
  } else if (msg.role === "assistant") {
    data.content = filterContentBlocks(msg.content, maxOutputLength);
    data.provider = msg.provider;
    data.model = msg.model;
    data.stopReason = msg.stopReason;
    if (msg.usage) {
      data.usage = {
        input: msg.usage.input,
        output: msg.usage.output,
        cacheRead: msg.usage.cacheRead,
        cacheWrite: msg.usage.cacheWrite,
        totalTokens: msg.usage.totalTokens,
        cost: msg.usage.cost?.total,
      };
    }
  } else if (msg.role === "toolResult") {
    data.toolCallId = msg.toolCallId;
    data.toolName = msg.toolName;
    data.isError = msg.isError;
    data.content = filterContentBlocks(msg.content, maxOutputLength);
    if (msg.details) {
      data.details = msg.details;
    }
  } else if (msg.role === "bashExecution") {
    data.command = msg.command;
    data.exitCode = msg.exitCode;
    data.cancelled = msg.cancelled;
    data.truncated = msg.truncated;
    data.output = truncateText(msg.output, maxOutputLength);
  } else if (msg.role === "custom") {
    data.customType = msg.customType;
    data.content =
      typeof msg.content === "string"
        ? truncateText(msg.content, maxOutputLength)
        : filterContentBlocks(msg.content, maxOutputLength);
  }

  return data;
}

/**
 * Main extension
 */
export default async function (pi: ExtensionAPI) {
  config = {
    url: getEnvVar("PI_OBSERVABILITY_URL") || "ws://localhost:8765/ws",
    apiKey: getEnvVar("PI_OBSERVABILITY_API_KEY") || getEnvVar("PENNY_OBSERVABILITY_API_KEY") || "",
    enabled: process.env.PI_OBSERVABILITY_ENABLED !== "false",
    autoStart: process.env.PI_OBSERVABILITY_AUTO_START !== "false",
    maxOutputLength: parseInt(getEnvVar("PI_OBSERVABILITY_MAX_OUTPUT_LENGTH") || "10000", 10),
    reconnectDelay: 1000,
    maxReconnectDelay: 30000,
    bufferSize: 1000,
  };

  _healthUrl = config.url.replace(/^ws/, "http").replace(/\/ws$/, "") + "/health";

  if (!config.enabled) {
    return;
  }

  // Auto-start the backend server if needed before connecting
  if (config.autoStart && !(await isServerAlive())) {
    if (startServer()) {
      const ready = await waitForServer();
      if (!ready) {
        logger.warn(
          "Observability server did not become ready",
          {},
          Object.assign(new Error("Server not ready"), {
            code: "OBSERVABILITY_SERVER_SPAWN_FAILED",
          })
        );
      }
    }
  }

  // Connect to observability server
  connect();

  // ============================================
  // SESSION LIFECYCLE
  // ============================================

  pi.on("session_start", async (event: any, ctx: any) => {
    sessionId = ctx.sessionManager.getSessionId();
    sessionStartTime = Date.now();
    setSessionId(sessionId);

    sendMessage("session_start", {
      reason: event.reason,
      previousSessionFile: event.previousSessionFile,
      cwd: ctx.cwd,
      sessionId,
      model: getModelInfo(ctx),
    });
  });

  pi.on("session_shutdown", async (_event: any, _ctx: any) => {
    _shuttingDown = true;
    sendMessage("session_shutdown", {
      sessionId,
      duration: Date.now() - sessionStartTime,
    });

    // Prevent reconnection after intentional shutdown
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    state.connected = false;
    const ws = state.ws;
    state.ws = null;
    if (ws) {
      try { ws.close(1000, "Session shutdown"); } catch { /* ignore */ }
    }
  });

  // ============================================
  // AGENT LIFECYCLE
  // ============================================

  pi.on("agent_start", async (_event: any, ctx: any) => {
    sendMessage("agent_start", {
      model: getModelInfo(ctx),
    });
  });

  pi.on("agent_end", async (event: any, _ctx: any) => {
    sendMessage("agent_end", {
      messageCount: event.messages?.length || 0,
    });
  });

  // ============================================
  // MESSAGE LIFECYCLE (only message_end)
  // ============================================

  pi.on("message_end", async (event: any, _ctx: any) => {
    const msg = event.message;
    const data = extractMessageData(msg, config.maxOutputLength);
    sendMessage("message_end", data);
  });

  // ============================================
  // TOOL EXECUTION
  // ============================================

  pi.on("tool_execution_start", async (event: any, _ctx: any) => {
    sendMessage("tool_execution_start", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
    });
  });

  pi.on("tool_result", async (event: any, _ctx: any) => {
    sendMessage("tool_result", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      hasContent: !!event.content,
    });
  });

  // ============================================
  // MODEL CHANGES
  // ============================================

  pi.on("model_select", async (event: any, _ctx: any) => {
    sendMessage("model_select", {
      model: event.model ? { provider: event.model.provider.id, id: event.model.id } : null,
      previousModel: event.previousModel
        ? { provider: event.previousModel.provider.id, id: event.previousModel.id }
        : null,
      source: event.source,
    });
  });

  // ============================================
  // TOOLS — Query observability data via REST API
  // ============================================

  // C2: Use PI_OBSERVABILITY_REST_URL directly as primary source,
  // falling back to derivation from WS URL only if not configured.
  const restBaseUrl = getEnvVar("PI_OBSERVABILITY_REST_URL") ||
    config.url.replace(/^ws/, "http").replace(/\/ws$/, "");
  const apiKey = config.apiKey;

  // C3: Differentiated error handling for observabilityFetch.
  // Distinguishes connection-refused, auth failure, server error, and timeout
  // for clear diagnostics in calling tools.
  async function observabilityFetch(path: string) {
    const url = `${restBaseUrl}${path}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    try {
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        if (resp.status === 401 || resp.status === 403) {
          throw new Error(`[AUTH] Observability server authentication failed (${resp.status}). Check PI_OBSERVABILITY_API_KEY in .env.`);
        }
        throw new Error(`[SERVER] Observability server returned ${resp.status}: ${text.slice(0, 200)}`);
      }
      return resp.json();
    } catch (err: any) {
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new Error(`[TIMEOUT] Observability server at ${restBaseUrl} did not respond within 10s. Is the server running?`);
      }
      if (err.cause?.code === "ECONNREFUSED" || err.message?.includes("fetch failed")) {
        throw new Error(`[CONNECTION_REFUSED] Cannot connect to observability server at ${restBaseUrl}. Start it with: python -m observability`);
      }
      // Re-throw with context if it's already one of our formatted errors
      if (err.message?.startsWith("[")) throw err;
      throw new Error(`[NETWORK] Observability request failed: ${err.message || "Unknown error"}`);
    }
  }

  pi.registerTool({
    name: "observability_query_logs",
    label: "Query Observability Logs",
    description:
      "Query operational log entries from the observability server. Returns structured log entries with level, component, message, timestamp, and optional error details. Use for diagnosing system errors, tracking extension behavior, or investigating issues.",
    promptSnippet: "Query structured log entries from the observability server",
    promptGuidelines: [
      "Use observability_query_logs when you need to inspect error logs, warnings, or other operational events.",
      "Filter by level (ERROR, WARN, INFO, DEBUG) and component (memory, skill, observability, etc.) to narrow results.",
      "Combine with observability_query_history to correlate log events with conversation timeline.",
    ],
    parameters: Type.Object({
      level: Type.Optional(
        Type.String({ description: "Filter by log level: DEBUG, INFO, WARN, ERROR, CRITICAL" })
      ),
      component: Type.Optional(
        Type.String({
          description: "Filter by extension/component name (e.g., memory, skill, observability)",
        })
      ),
      session_id: Type.Optional(Type.String({ description: "Filter by session ID" })),
      from_ts: Type.Optional(
        Type.Number({ description: "Start timestamp (milliseconds since epoch)" })
      ),
      to_ts: Type.Optional(
        Type.Number({ description: "End timestamp (milliseconds since epoch)" })
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 50, max 500)", minimum: 1, maximum: 500 })
      ),
      offset: Type.Optional(
        Type.Number({ description: "Pagination offset (default 0)", minimum: 0 })
      ),
    }),
    async execute(_toolCallId: string, params: any) {
      try {
        const query = new URLSearchParams();
        if (params.level) query.set("level", params.level);
        if (params.component) query.set("component", params.component);
        if (params.session_id) query.set("session_id", params.session_id);
        if (params.from_ts != null) query.set("from_ts", String(params.from_ts));
        if (params.to_ts != null) query.set("to_ts", String(params.to_ts));
        if (params.limit != null) query.set("limit", String(params.limit));
        if (params.offset != null) query.set("offset", String(params.offset));
        const qs = query.toString();
        const data = await observabilityFetch(`/logs${qs ? `?${qs}` : ""}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          details: data,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("observability_query_logs failed", { error: msg });
        return {
          content: [{ type: "text" as const, text: `Error querying logs: ${msg}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "observability_query_watcher_logs",
    label: "Query Ambient Watcher Logs",
    description:
      "Query structured ambient watcher log entries from the observability server. These logs are kept logically separate from general operational logs and capture the internal execution of Penny's ambient watcher scripts (mismatch_rate_watcher, confidence_trend_watcher, mempalace_growth_watcher, task_staleness_watcher, etc.). Use this to investigate watcher behavior, signal generation decisions, or why a particular signal was or wasn't raised.",
    promptSnippet: "Query ambient watcher execution logs",
    promptGuidelines: [
      "Use observability_query_watcher_logs when diagnosing signal generation issues or understanding watcher behavior.",
      "Filter by source (e.g., mismatch_rate_watcher, confidence_trend_watcher) to focus on a specific watcher.",
      "Filter by level (ERROR, WARN) to find watcher failures or anomalies.",
      "Watcher logs are logically separated from general operational logs — do NOT use observability_query_logs for watcher-specific queries.",
    ],
    parameters: Type.Object({
      level: Type.Optional(
        Type.String({ description: "Filter by log level: DEBUG, INFO, WARN, ERROR" })
      ),
      source: Type.Optional(
        Type.String({
          description:
            "Filter by watcher source name (e.g., mismatch_rate_watcher, ambient_watchers, session_start_checker)",
        })
      ),
      session_id: Type.Optional(Type.String({ description: "Filter by session ID" })),
      from_ts: Type.Optional(
        Type.Number({ description: "Start timestamp (milliseconds since epoch)" })
      ),
      to_ts: Type.Optional(
        Type.Number({ description: "End timestamp (milliseconds since epoch)" })
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 50, max 500)", minimum: 1, maximum: 500 })
      ),
      offset: Type.Optional(
        Type.Number({ description: "Pagination offset (default 0)", minimum: 0 })
      ),
    }),
    async execute(_toolCallId: string, params: any) {
      try {
        const query = new URLSearchParams();
        if (params.level) query.set("level", params.level);
        if (params.source) query.set("source", params.source);
        if (params.session_id) query.set("session_id", params.session_id);
        if (params.from_ts != null) query.set("from_ts", String(params.from_ts));
        if (params.to_ts != null) query.set("to_ts", String(params.to_ts));
        if (params.limit != null) query.set("limit", String(params.limit));
        if (params.offset != null) query.set("offset", String(params.offset));
        const qs = query.toString();
        const data = await observabilityFetch(`/watcher_logs${qs ? `?${qs}` : ""}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          details: data,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("observability_query_watcher_logs failed", { error: msg });
        return {
          content: [{ type: "text" as const, text: `Error querying watcher logs: ${msg}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "observability_query_history",
    label: "Query Conversation History",
    description:
      "Query conversation history (entries) from the observability server for a specific session. Returns messages, tool results, agent lifecycle events, and model changes in chronological order. Use to reconstruct what happened during a session.",
    promptSnippet: "Query conversation history for a specific session",
    promptGuidelines: [
      "Use observability_query_history when you need to reconstruct a conversation timeline.",
      "First call without session_id to list recent sessions, then use a specific session_id to get its entries.",
      "Combine with observability_query_logs to correlate conversation events with error logs.",
    ],
    parameters: Type.Object({
      session_id: Type.Optional(
        Type.String({ description: "Session ID to query. Omit to list all sessions." })
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Max entries per page (default 50, max 500)",
          minimum: 1,
          maximum: 500,
        })
      ),
      offset: Type.Optional(
        Type.Number({ description: "Pagination offset (default 0)", minimum: 0 })
      ),
    }),
    async execute(_toolCallId: string, params: any) {
      try {
        if (params.session_id) {
          const query = new URLSearchParams();
          if (params.limit != null) query.set("limit", String(params.limit));
          if (params.offset != null) query.set("offset", String(params.offset));
          const qs = query.toString();
          const data = await observabilityFetch(
            `/sessions/${encodeURIComponent(params.session_id)}/entries${qs ? `?${qs}` : ""}`
          );
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
            details: data,
          };
        } else {
          const query = new URLSearchParams();
          if (params.limit != null) query.set("limit", String(params.limit));
          if (params.offset != null) query.set("offset", String(params.offset));
          const qs = query.toString();
          const data = await observabilityFetch(`/sessions${qs ? `?${qs}` : ""}`);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
            details: data,
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("observability_query_history failed", { error: msg });
        return {
          content: [{ type: "text" as const, text: `Error querying history: ${msg}` }],
          isError: true,
        };
      }
    },
  });

  // ============================================
  // COMMANDS
  // ============================================

  pi.registerCommand("observability-status", {
    description: "Check observability server connection status",
    handler: async (_args: string, ctx: any) => {
      const status = state.connected ? "Connected" : "Disconnected";
      const queued = messageQueue.length;
      const reconnecting = state.reconnectAttempts > 0;

      ctx.ui.notify(
        `Observability: ${status}${queued ? ` (${queued} queued)` : ""}${reconnecting ? " - Reconnecting..." : ""}`,
        "info"
      );
    },
  });

  pi.registerCommand("observability-reconnect", {
    description: "Force reconnect to observability server",
    handler: async (_args: string, ctx: any) => {
      state.reconnectAttempts = 0;
      connect(true);
      ctx.ui.notify("Reconnecting to observability server...", "info");
    },
  });
}

// ============================================================
// Server Auto-Start
// ============================================================

/** Parsed HTTP base URL for health checks (ws:// → http://). */
let _healthUrl: string;

let _serverProc: ReturnType<typeof spawn> | null = null;
let _serverStartedByExtension = false;
let _restartAttempt = 0;
let _restartTimer: ReturnType<typeof setTimeout> | null = null;
let _shuttingDown = false;

/** Check whether the observability server is already running. */
async function isServerAlive(): Promise<boolean> {
  try {
    const resp = await fetch(_healthUrl, { signal: AbortSignal.timeout(800) });
    return resp.ok;
  } catch {
    logger.debug("Observability health check failed");
    return false;
  }
}

/** Poll /health until it returns 200 or timeout elapses. */
async function waitForServer(maxWaitMs = 10000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await isServerAlive()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** Start the Python observability backend if it isn't already running. */
function startServer(): boolean {
  if (_serverProc) return true;

  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const pythonPath = _findPython(projectRoot);
  const scriptEntry = resolve(projectRoot, "apps/observability/src/observability/__main__.py");

  if (!existsSync(scriptEntry)) {
    logger.warn(
      "Server entry not found",
      { path: scriptEntry },
      Object.assign(new Error("Server entry not found"), {
        code: "OBSERVABILITY_SERVER_SPAWN_FAILED",
      })
    );
    return false;
  }

  // A3: Pre-spawn import validation — verify all critical modules before spawning.
  // _findPython already validated `import observability`, but we also check
  // specific submodules that are needed for server operation.
  const pythonPathEnv = resolve(projectRoot, "apps/observability/src");
  const { execSync } = require("child_process");
  try {
    execSync(
      `"${pythonPath}" -c "from observability.main import app; from observability.db import Database; from observability.scheduler import start_scheduler; from observability.config import Config; from observability.models import LogEntry"`,
      { env: { ...process.env, PYTHONPATH: pythonPathEnv }, timeout: 10000, stdio: "pipe" }
    );
    logger.info("Observability server pre-spawn validation passed", { python: pythonPath });
  } catch (err: any) {
    const stderr = err.stderr?.toString() || "";
    logger.error(
      "Observability server pre-spawn validation failed",
      { python: pythonPath, stderr: stderr.slice(0, 500) },
      Object.assign(new Error(`Pre-spawn validation failed: ${stderr.slice(0, 200)}`), {
        code: "OBSERVABILITY_SERVER_SPAWN_FAILED",
      })
    );
    return false;
  }

  const env = {
    ...process.env,
    PYTHONPATH: pythonPathEnv,
  };

  logger.info("Observability server auto-starting", { port: new URL(config.url).port });
  // B1: Capture stderr/stdout instead of ignoring — pipe to capture startup errors
  _serverProc = spawn(pythonPath, ["-m", "observability"], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // B1: Route captured stderr to structured logger for diagnostics
  if (_serverProc.stderr) {
    let stderrBuffer = "";
    _serverProc.stderr.on("data", (data: Buffer) => {
      stderrBuffer += data.toString();
      // Flush on newlines for real-time visibility
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          logger.info("Observability server stderr", { message: line.trim() });
        }
      }
    });
    _serverProc.stderr.on("end", () => {
      if (stderrBuffer.trim()) {
        logger.info("Observability server stderr", { message: stderrBuffer.trim() });
      }
    });
  }
  if (_serverProc.stdout) {
    let stdoutBuffer = "";
    _serverProc.stdout.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          logger.debug("Observability server stdout", { message: line.trim() });
        }
      }
    });
  }

  _serverStartedByExtension = true;

  // B2: Auto-restart with exponential backoff
  _serverProc.on("exit", (code) => {
    logger.warn("Observability server exited", { code, restartAttempt: _restartAttempt });
    _serverProc = null;

    // Don't restart during intentional shutdown
    if (_shuttingDown) return;

    // Try auto-restart with exponential backoff
    const maxRestarts = 5;
    if (_restartAttempt >= maxRestarts) {
      logger.error(
        `Observability server crashed ${maxRestarts} times — giving up`,
        {},
        Object.assign(new Error("Max auto-restarts reached"), {
          code: "OBSERVABILITY_SERVER_SPAWN_FAILED",
        })
      );
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, _restartAttempt), 30000);
    _restartAttempt++;
    logger.info(`Auto-restarting observability server in ${delay / 1000}s (attempt ${_restartAttempt}/${maxRestarts})`);
    _restartTimer = setTimeout(() => {
      startServer();
    }, delay);
    _restartTimer.unref();
  });

  _serverProc.on("error", (err) => {
    logger.error(
      "Observability server spawn failed",
      { error: err.message, restartAttempt: _restartAttempt },
      Object.assign(err, { code: "OBSERVABILITY_SERVER_SPAWN_FAILED" })
    );
    _serverProc = null;
  });

  return true;
}

/** Terminate the server process if we spawned it. */
function stopServer(): void {
  _shuttingDown = true;
  if (_restartTimer) {
    clearTimeout(_restartTimer);
    _restartTimer = null;
  }
  if (_serverProc && _serverStartedByExtension) {
    _serverProc.kill("SIGTERM");
    _serverProc = null;
  }
}

function _findPython(projectRoot: string): string {
  const candidates = [
    resolve(projectRoot, ".venv/bin/python"),
    resolve(projectRoot, ".venv/bin/python3"),
    "python3",
  ];

  const scriptEntry = resolve(projectRoot, "apps/observability/src/observability/__main__.py");
  const pythonPath = resolve(projectRoot, "apps/observability/src");
  const { execSync } = require("child_process");

  for (const c of candidates) {
    if (!existsSync(c)) continue;

    // Validate that this Python can import the observability module.
    // Must match the PYTHONPATH set in startServer() for spawn.
    try {
      execSync(`"${c}" -c "import observability"`, {
        env: { ...process.env, PYTHONPATH: pythonPath },
        timeout: 5000,
        stdio: "pipe",
      });
      logger.debug("Python env validated", { python: c, pythonPath });
      return c;
    } catch {
      logger.warn(
        `Python at ${c} found on disk but cannot import observability module`,
        { python: c, pythonPath },
        Object.assign(
          new Error(`Python env validation failed for ${c}`),
          { code: "OBSERVABILITY_PYTHON_VALIDATION_FAILED" }
        )
      );
      // Continue to next candidate
    }
  }

  // No valid Python found — return system python3 as last resort with warning
  logger.error(
    "No Python environment found that can import observability. Install with: uv pip install -e apps/observability",
    {},
    Object.assign(
      new Error("No valid Python environment for observability"),
      { code: "OBSERVABILITY_SERVER_SPAWN_FAILED" }
    )
  );
  return "python3";
}

// Ensure the server is killed when Pi exits (SIGTERM / SIGINT / exit)
process.on("exit", stopServer);
process.on("SIGINT", () => {
  stopServer();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopServer();
  process.exit(0);
});
