import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestLogger } from "../../../../lib/logger/test-logger.js";

/**
 * Observability extension logging unit tests.
 */

// Ensure INFO-level logs are captured
process.env.PI_LOG_LEVEL = "INFO";
describe("observability extension structured logging", () => {
  let { logger, buffer, clear, setSessionId } = createTestLogger("observability");

  beforeEach(() => {
    clear();
    setSessionId("obs-session-456");
  });

  it("emits structured ERROR log for WebSocket error with OBSERVABILITY_WS_ERROR code", () => {
    const err = Object.assign(new Error("Connection refused"), { code: "OBSERVABILITY_WS_ERROR" as const });
    logger.error("WebSocket error", {}, err);
    expect(buffer).toHaveLength(1);
    expect(buffer[0].error?.code).toBe("OBSERVABILITY_WS_ERROR");
    expect(buffer[0].sessionId).toBe("obs-session-456");
  });

  it("emits structured WARN log for queue overflow with OBSERVABILITY_QUEUE_OVERFLOW code", () => {
    const err = Object.assign(new Error("Queue overflow"), {
      code: "OBSERVABILITY_QUEUE_OVERFLOW" as const,
    });
    logger.warn("Message queue overflow, dropping oldest", { queueSize: 1000 }, err);
    expect(buffer).toHaveLength(1);
    expect(buffer[0].error?.code).toBe("OBSERVABILITY_QUEUE_OVERFLOW");
  });

  it("emits structured INFO log for server auto-start lifecycle", () => {
    logger.info("Observability server auto-starting", { port: "8765" });
    expect(buffer).toHaveLength(1);
    expect(buffer[0].level).toBe(1); // INFO
    expect(buffer[0].message).toBe("Observability server auto-starting");
  });
});
