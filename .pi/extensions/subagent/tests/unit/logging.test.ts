import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestLogger } from "../../../../lib/logger/test-logger.js";

// Ensure INFO-level logs are captured (default is WARN, which would filter out INFO)
process.env.PI_LOG_LEVEL = "INFO";

describe("agent-runner structured logging", () => {
  let { logger, buffer, clear, setSessionId } = createTestLogger("agent-runner");

  beforeEach(() => {
    clear();
    setSessionId("agent-session-001");
  });

  it("emits structured ERROR log for agent spawn failure with AGENT_SPAWN_ERROR code", () => {
    const err = Object.assign(new Error("ENOENT"), { code: "AGENT_SPAWN_ERROR" });
    logger.error("Agent spawn failed", { agent: "echo" }, err);
    expect(buffer).toHaveLength(1);
    expect(buffer[0].error?.code).toBe("AGENT_SPAWN_ERROR");
    expect(buffer[0].sessionId).toBe("agent-session-001");
  });

  it("emits structured WARN log for missing message_end with AGENT_INCOMPLETE code", () => {
    const err = Object.assign(new Error("No message_end"), { code: "AGENT_INCOMPLETE" });
    logger.warn(
      "Agent completed without message_end",
      { agent: "piper", events: 5, exitCode: 0 },
      err
    );
    expect(buffer).toHaveLength(1);
    expect(buffer[0].error?.code).toBe("AGENT_INCOMPLETE");
  });

  it("emits structured INFO log on successful agent completion", () => {
    logger.info("Agent completed", { agent: "echo", events: 12, exitCode: 0 });
    expect(buffer).toHaveLength(1);
    expect(buffer[0].level).toBe(1); // INFO
    expect(buffer[0].message).toBe("Agent completed");
  });
});
