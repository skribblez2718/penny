/**
 * Shared structured logger for all Penny extensions.
 *
 * Design decisions (Step 1b):
 * - Session ID injection: each extension's `session_start` handler calls
 *   `setSessionId(ctx.sessionManager.getSessionId())`.
 * - Extension-level sessionId: some extensions currently lack `session_start`
 *   handlers (compaction uses `session_before_compact`, search has none).
 *   For these, add a `pi.on("session_start", ...)` handler.
 * - `agent-runner.ts` does NOT call `setSessionId()` itself; sessionId
 *   flows from callers via the module-level `globalSessionId` fallback.
 * - `questionnaire`, `statusline`, and `environment` are exempt from
 *   remediation (no meaningful error paths).
 */

// ── Severity levels ──────────────────────────────────────
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  CRITICAL = 4,
}

// ── ErrorCode taxonomy ───────────────────────────────────
// NOTE: keep in sync with docs/agents/capabilities/error-logging/error-codes.md
export type ErrorCode =
  // memory bridge
  | "BRIDGE_TIMEOUT"
  | "BRIDGE_SPAWN_ERROR"
  | "BRIDGE_PARSE_ERROR"
  | "BRIDGE_EXIT_CODE"
  // skill / orchestration
  | "PYTHON_SPAWN_ERROR"
  | "PYTHON_TIMEOUT"
  | "PYTHON_PARSE_ERROR"
  | "AGENT_SPAWN_ERROR"
  | "AGENT_TIMEOUT"
  | "AGENT_INCOMPLETE"
  | "AGENT_BATCH_ERROR"
  | "AGENT_ERROR"
  | "SUBAGENT_INVOCATION_FAILED"
  | "SKILL_CHAIN_CHECKPOINT_READ_FAILED"
  | "SKILL_NO_PYTHON_INTERPRETER"
  | "SKILL_REPORT_EMAIL_FAILED"
  | "SKILL_EXECUTION_FAILED"
  // compaction
  | "COMPACTION_MEMPALACE_QUERY_FAILED"
  | "COMPACTION_KG_QUERY_FAILED"
  | "COMPACTION_OUTCOME_QUERY_FAILED"
  | "COMPACTION_POST_FAILED"
  | "COMPACTION_VALIDATION_FAILED"
  | "COMPACTION_BUDGET_OVERFLOW"
  // search
  | "SEARCH_API_KEY_MISSING"
  | "SEARCH_CLIENT_ERROR"
  | "SEARCH_SERVER_ERROR"
  | "SEARCH_NETWORK_ERROR"
  | "SEARCH_ABORTED"
  // observability
  | "OBSERVABILITY_WS_ERROR"
  | "OBSERVABILITY_SERVER_SPAWN_FAILED"
  | "OBSERVABILITY_QUEUE_OVERFLOW"
  | "OBSERVABILITY_QUERY_LOGS_FAILED"
  | "OBSERVABILITY_QUERY_WATCHER_LOGS_FAILED"
  | "OBSERVABILITY_QUERY_HISTORY_FAILED"
  | "OBSERVABILITY_NULL_MODEL_PROVIDER"
  | "OBSERVABILITY_PYTHON_VALIDATION_FAILED";

// ── Structured log entry ───────────────────────────────
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  extension: string;
  message: string;
  sessionId?: string;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: ErrorCode;
  };
  context?: Record<string, unknown>;
}

// ── Transport ────────────────────────────────────────────
export type LogTransport = (entry: string) => void;

// ── Logger API ───────────────────────────────────────────
export interface Logger {
  debug(
    message: string,
    context?: Record<string, unknown>,
    error?: Error & { code?: ErrorCode }
  ): void;
  info(
    message: string,
    context?: Record<string, unknown>,
    error?: Error & { code?: ErrorCode }
  ): void;
  warn(
    message: string,
    context?: Record<string, unknown>,
    error?: Error & { code?: ErrorCode }
  ): void;
  error(
    message: string,
    context?: Record<string, unknown>,
    error?: Error & { code?: ErrorCode }
  ): void;
  critical(
    message: string,
    context?: Record<string, unknown>,
    error?: Error & { code?: ErrorCode }
  ): void;
}

// ── Session ID management (module-level) ───────────────
let globalSessionId = "";

export function setSessionId(sessionId: string): void {
  const current = globalSessionId;
  if (current && current !== sessionId) {
    // Defensive: overwrite warning — send to observability server, not stderr
    sendLogViaRest({
      level: "WARN",
      component: "logger",
      event: `Overwriting sessionId ${current.slice(0, 8)}… → ${sessionId.slice(0, 8)}…`,
      client_id: "penny-extension",
    });
  }
  globalSessionId = sessionId;
}

export function getSessionId(): string {
  return globalSessionId || "";
}

// ── REST fallback transport ────────────────────────────────
const DEFAULT_REST_URL = "http://localhost:8765";
const REST_BASE_URL = (() => {
  const raw = process.env.PI_OBSERVABILITY_URL;
  if (!raw) return DEFAULT_REST_URL;
  try {
    return raw.replace(/^ws/, "http").replace(/\/ws$/, "");
  } catch {
    return DEFAULT_REST_URL;
  }
})();
const REST_API_KEY =
  process.env.PI_OBSERVABILITY_API_KEY || process.env.PENNY_OBSERVABILITY_API_KEY || "";

let restCircuitOpenUntil = 0;

function sendLogViaRest(payload: Record<string, unknown>): void {
  if (Date.now() < restCircuitOpenUntil) return;
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (REST_API_KEY) {
      headers["Authorization"] = `Bearer ${REST_API_KEY}`;
    }
    fetch(`${REST_BASE_URL}/logs`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }).catch(() => {
      // Brief circuit-breaker to avoid hammering a down server
      restCircuitOpenUntil = Date.now() + 30_000;
    });
  } catch {
    /* fetch may not be available in older Node versions */
  }
}

/** Fallback transport: posts structured log entries to the
 *  observability server's `/logs` REST endpoint so logs are
 *  never lost when the WebSocket transport is not active. */
function defaultTransport(entry: string): void {
  try {
    const parsed = JSON.parse(entry);
    const levelName =
      typeof parsed.level === "number" ? LogLevel[parsed.level] : parsed.level || "INFO";
    sendLogViaRest({
      level: levelName,
      component: parsed.extension || "unknown",
      event: parsed.message || entry,
      session_id: parsed.sessionId,
      client_id: "penny-extension",
      data: {
        ...(parsed.context || {}),
        ...(parsed.error ? { error: parsed.error } : {}),
      },
    });
  } catch {
    // Not JSON (text format) — send entire text as the event field
    sendLogViaRest({
      level: "INFO",
      component: "unknown",
      event: entry,
      client_id: "penny-extension",
      data: { _format: "text" },
    });
  }
}

// ── Environment config ─────────────────────────────────
const DEFAULT_LEVEL = LogLevel.WARN;
const DEFAULT_FORMAT: "json" | "text" = "json";

function parseLevel(raw?: string): LogLevel {
  if (!raw) return DEFAULT_LEVEL;
  switch (raw.trim().toUpperCase()) {
    case "DEBUG":
      return LogLevel.DEBUG;
    case "INFO":
      return LogLevel.INFO;
    case "WARN":
      return LogLevel.WARN;
    case "ERROR":
      return LogLevel.ERROR;
    case "CRITICAL":
      return LogLevel.CRITICAL;
    default:
      emitFallbackWarn(`Invalid PI_LOG_LEVEL "${raw}" — using WARN`);
      return DEFAULT_LEVEL;
  }
}

function parseFormat(raw?: string): "json" | "text" {
  if (!raw) return DEFAULT_FORMAT;
  const v = raw.trim().toLowerCase();
  if (v === "json" || v === "text") return v;
  emitFallbackWarn(`Invalid PI_LOG_FORMAT "${raw}" — using json`);
  return DEFAULT_FORMAT;
}

function emitFallbackWarn(msg: string): void {
  sendLogViaRest({
    level: "WARN",
    component: "logger",
    event: msg,
    client_id: "penny-extension",
  });
}

// ── Logger factory ─────────────────────────────────────
let globalTransport: LogTransport | undefined;

export function setGlobalLogTransport(transport: LogTransport | undefined): void {
  globalTransport = transport;
}

export function createLogger(extension: string, transport?: LogTransport): Logger {
  const configuredLevel = parseLevel(process.env.PI_LOG_LEVEL);
  const configuredFormat = parseFormat(process.env.PI_LOG_FORMAT);
  const localDefaultTransport: LogTransport = defaultTransport;
  const write = transport ?? globalTransport ?? localDefaultTransport;

  function log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    error?: Error & { code?: ErrorCode }
  ): void {
    if (level < configuredLevel) return;

    const entry: Omit<LogEntry, "error"> & Partial<Pick<LogEntry, "error">> = {
      timestamp: new Date().toISOString(),
      level,
      extension,
      message,
      sessionId: getSessionId() || undefined,
      context,
    };

    if (error) {
      entry.error = {
        name: error.name ?? "Error",
        message: error.message ?? "",
        code: error.code,
      };
      if (error.stack && level >= LogLevel.ERROR) {
        entry.error.stack = error.stack;
      }
    }

    if (configuredFormat === "text") {
      const levelName = LogLevel[level];
      let text = `[${entry.timestamp}] [${levelName}] [${extension}] ${message}`;
      if (entry.sessionId) text += ` (sessionId=${entry.sessionId})`;
      if (context) {
        const ctx = Object.entries(context)
          .map(([k, v]) => {
            const val = typeof v === "string" ? v : JSON.stringify(v);
            return `${k}=${val}`;
          })
          .join(", ");
        if (ctx) text += ` {${ctx}}`;
      }
      if (entry.error) {
        text += ` <${entry.error.code || entry.error.name}: ${entry.error.message}>`;
      }
      write(text);
    } else {
      // Remove undefined fields for cleaner JSON
      const clean = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined));
      write(JSON.stringify(clean));
    }
  }

  return {
    debug: (msg, ctx, err) => log(LogLevel.DEBUG, msg, ctx, err),
    info: (msg, ctx, err) => log(LogLevel.INFO, msg, ctx, err),
    warn: (msg, ctx, err) => log(LogLevel.WARN, msg, ctx, err),
    error: (msg, ctx, err) => log(LogLevel.ERROR, msg, ctx, err),
    critical: (msg, ctx, err) => log(LogLevel.CRITICAL, msg, ctx, err),
  };
}
