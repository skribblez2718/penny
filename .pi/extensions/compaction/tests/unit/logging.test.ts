import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestLogger } from "../../../../lib/logger/test-logger.js";

describe("compaction extension structured logging", () => {
  let { logger, buffer, clear, setSessionId } = createTestLogger("compaction");

  beforeEach(() => {
    clear();
    setSessionId("compact-session-002");
  });

  it("emits a structured checkpointer read failure", () => {
    const err = Object.assign(new Error("Read rejected"), {
      code: "COMPACTION_ENGINE_QUERY_FAILED",
    });
    logger.error("Exact checkpointer read failed", { error: "Read rejected" }, err);
    expect(buffer).toHaveLength(1);
    expect(buffer[0].error?.code).toBe("COMPACTION_ENGINE_QUERY_FAILED");
  });

  it("emits structured ERROR log for validation failure with COMPACTION_VALIDATION_FAILED code", () => {
    const err = Object.assign(new Error("Missing goal"), { code: "COMPACTION_VALIDATION_FAILED" });
    logger.error("Compaction artifact validation failed", { errors: ["Missing goal"] }, err);
    expect(buffer).toHaveLength(1);
    expect(buffer[0].error?.code).toBe("COMPACTION_VALIDATION_FAILED");
  });

  it("emits a structured shared result-budget overflow", () => {
    const err = Object.assign(new Error("Budget exceeded"), { code: "COMPACTION_BUDGET_OVERFLOW" });
    logger.warn("Compaction result budget exceeded", { budget: 10000, actual: 12000 }, err);
    expect(buffer).toHaveLength(1);
    expect(buffer[0].error?.code).toBe("COMPACTION_BUDGET_OVERFLOW");
  });
});
