import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestLogger } from "../../../../lib/logger/test-logger.js";

/**
 * Memory extension logging unit tests.
 * Validates structured error logging for bridge and observability paths.
 */

describe("memory extension structured logging", () => {
  let { logger, buffer, clear, setSessionId } = createTestLogger("memory");

  beforeEach(() => {
    clear();
    setSessionId("test-session-123");
  });

  afterEach(() => {
    clear();
    setSessionId("");
  });

  it("emits structured ERROR log for bridge timeout with BRIDGE_TIMEOUT code", () => {
    const err = Object.assign(new Error("Bridge timed out after 30000ms"), {
      code: "BRIDGE_TIMEOUT" as const,
    });
    logger.error("Bridge timeout", { tool: "status", duration: "30s" }, err);
    expect(buffer).toHaveLength(1);
    expect(buffer[0].level).toBe(3); // ERROR
    expect(buffer[0].extension).toBe("memory");
    expect(buffer[0].error?.code).toBe("BRIDGE_TIMEOUT");
    expect(buffer[0].sessionId).toBe("test-session-123");
  });

  it("emits structured WARN log for bridge parse error with BRIDGE_PARSE_ERROR code", () => {
    const err = Object.assign(new Error("Failed to parse"), { code: "BRIDGE_PARSE_ERROR" as const });
    logger.warn("Bridge response parse error", { tool: "status", exitCode: 1, stderr: "" }, err);
    expect(buffer).toHaveLength(1);
    expect(buffer[0].level).toBe(2); // WARN
    expect(buffer[0].error?.code).toBe("BRIDGE_PARSE_ERROR");
  });

  it("emits structured DEBUG log for observability emit failure (suppressed at default WARN)", () => {
    process.env.PI_LOG_LEVEL = "DEBUG";
    const {
      logger: debugLogger,
      buffer: debugBuffer,
      clear: debugClear,
      setSessionId: debugSet,
    } = createTestLogger("memory");
    debugSet("test-session-123");
    debugLogger.debug("Observability emit failed", { tool: "mempalace_search" });
    expect(debugBuffer).toHaveLength(1);
    expect(debugBuffer[0].level).toBe(0); // DEBUG
    expect(debugBuffer[0].message).toBe("Observability emit failed");
    delete process.env.PI_LOG_LEVEL;
    debugClear();
  });
});
