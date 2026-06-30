import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestLogger } from "../../../../lib/logger/test-logger.js";

describe("skill extension structured logging", () => {
  let { logger, buffer, clear, setSessionId } = createTestLogger("skill");

  beforeEach(() => {
    clear();
    setSessionId("skill-session-789");
  });

  it("emits structured ERROR log for Python timeout with PYTHON_TIMEOUT code", () => {
    const err = Object.assign(new Error("Timed out"), { code: "PYTHON_TIMEOUT" });
    logger.error("Python timeout", { step: "start", timeout: "10000ms" }, err);
    expect(buffer).toHaveLength(1);
    expect(buffer[0].error?.code).toBe("PYTHON_TIMEOUT");
    expect(buffer[0].sessionId).toBe("skill-session-789");
  });

  it("emits structured WARN log for Python parse error with PYTHON_PARSE_ERROR code", () => {
    const err = Object.assign(new Error("Invalid JSON"), { code: "PYTHON_PARSE_ERROR" });
    logger.warn("Python response parse error", { step: "start", exitCode: 1, stderr: "" }, err);
    expect(buffer).toHaveLength(1);
    expect(buffer[0].error?.code).toBe("PYTHON_PARSE_ERROR");
  });

  it("emits structured DEBUG log for signal check failure (DEBUG level required)", () => {
    process.env.PI_LOG_LEVEL = "DEBUG";
    const { logger: dl, buffer: db, clear: dc, setSessionId: ds } = createTestLogger("skill");
    ds("skill-session-789");
    dl.debug("Signal check failed", { error: "spawn error" });
    expect(db).toHaveLength(1);
    expect(db[0].level).toBe(0);
    delete process.env.PI_LOG_LEVEL;
    dc();
  });
});
