import {
  createLogger,
  setSessionId,
  getSessionId,
  LogLevel,
  type ErrorCode,
  type LogEntry,
} from "./logger.js";

const ERROR_CODES: ReadonlySet<string> = new Set([
  "BRIDGE_TIMEOUT",
  "BRIDGE_SPAWN_ERROR",
  "BRIDGE_PARSE_ERROR",
  "BRIDGE_EXIT_CODE",
  "PYTHON_SPAWN_ERROR",
  "PYTHON_TIMEOUT",
  "PYTHON_PARSE_ERROR",
  "AGENT_SPAWN_ERROR",
  "AGENT_TIMEOUT",
  "AGENT_INCOMPLETE",
  "AGENT_BATCH_ERROR",
  "AGENT_ERROR",
  "SUBAGENT_INVOCATION_FAILED",
  "SKILL_CHAIN_CHECKPOINT_READ_FAILED",
  "SKILL_NO_PYTHON_INTERPRETER",
  "SKILL_REPORT_EMAIL_FAILED",
  "SKILL_EXECUTION_FAILED",
  "COMPACTION_MEMPALACE_QUERY_FAILED",
  "COMPACTION_KG_QUERY_FAILED",
  "COMPACTION_OUTCOME_QUERY_FAILED",
  "COMPACTION_POST_FAILED",
  "COMPACTION_VALIDATION_FAILED",
  "COMPACTION_BUDGET_OVERFLOW",
  "COMPACTION_YIELDED_TO_DEFAULT",
  "COMPACTION_ENGINE_QUERY_FAILED",
  "SEARCH_API_KEY_MISSING",
  "SEARCH_CLIENT_ERROR",
  "SEARCH_SERVER_ERROR",
  "SEARCH_NETWORK_ERROR",
  "SEARCH_ABORTED",
  "OBSERVABILITY_SERVER_SPAWN_FAILED",
  "OBSERVABILITY_QUERY_LOGS_FAILED",
  "OBSERVABILITY_QUERY_HISTORY_FAILED",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4;
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && ERROR_CODES.has(value);
}

function isLogEntry(value: unknown): value is LogEntry {
  if (
    !isRecord(value) ||
    typeof value.timestamp !== "string" ||
    !isLogLevel(value.level) ||
    typeof value.extension !== "string" ||
    typeof value.message !== "string" ||
    (value.sessionId !== undefined && typeof value.sessionId !== "string") ||
    (value.context !== undefined && !isRecord(value.context))
  ) {
    return false;
  }
  if (value.error === undefined) return true;
  return (
    isRecord(value.error) &&
    typeof value.error.name === "string" &&
    typeof value.error.message === "string" &&
    (value.error.stack === undefined || typeof value.error.stack === "string") &&
    (value.error.code === undefined || isErrorCode(value.error.code))
  );
}

export interface TestLoggerResult {
  logger: ReturnType<typeof createLogger>;
  buffer: LogEntry[];
  clear: () => void;
  setSessionId: typeof setSessionId;
  getSessionId: typeof getSessionId;
}

/**
 * Create a test logger that captures structured log entries into an in-memory
 * buffer instead of writing to stderr. Use for ALL unit tests.
 *
 * Never use `vi.spyOn(process.stderr, ...)` in unit tests — only in
 * integration tests. This utility keeps vitest output clean.
 */
export function createTestLogger(extension: string = "test"): TestLoggerResult {
  const buffer: LogEntry[] = [];

  const logger = createLogger(extension, (entry: string) => {
    try {
      const parsed: unknown = JSON.parse(entry);
      if (!isLogEntry(parsed)) throw new TypeError("logger emitted an invalid entry");
      buffer.push(parsed);
    } catch {
      // Text-format fallback — store raw string in a synthetic entry
      buffer.push({
        timestamp: new Date().toISOString(),
        level: LogLevel.DEBUG,
        extension,
        message: entry,
      });
    }
  });

  return {
    logger,
    buffer,
    clear: () => {
      buffer.length = 0;
    },
    setSessionId,
    getSessionId,
  };
}
