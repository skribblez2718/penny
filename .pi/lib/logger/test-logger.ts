import { createLogger, setSessionId, getSessionId, type LogEntry } from "./logger.js";

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
      buffer.push(JSON.parse(entry) as LogEntry);
    } catch {
      // Text-format fallback — store raw string in a synthetic entry
      buffer.push({
        timestamp: new Date().toISOString(),
        level: 0, // DEBUG placeholder
        extension,
        message: entry,
      } as LogEntry);
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
