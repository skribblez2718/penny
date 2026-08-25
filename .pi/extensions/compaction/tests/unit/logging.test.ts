import { beforeEach, describe, expect, it } from "vitest";
import type { ErrorCode } from "../../../../lib/logger/logger.js";
import { createTestLogger } from "../../../../lib/logger/test-logger.js";

function codedError(message: string, code: ErrorCode): Error & { code: ErrorCode } {
  return Object.assign(new Error(message), { code });
}

describe("compaction extension structured logging", () => {
  const { logger, buffer, clear, setSessionId } = createTestLogger("compaction");

  beforeEach(() => {
    clear();
    setSessionId("compact-session-002");
  });

  it("emits a structured checkpointer read failure", () => {
    const err = codedError("Read rejected", "COMPACTION_ENGINE_QUERY_FAILED");
    logger.error("Exact checkpointer read failed", { error: "Read rejected" }, err);
    expect(buffer).toHaveLength(1);
    expect(buffer[0].error?.code).toBe("COMPACTION_ENGINE_QUERY_FAILED");
  });

  it("emits structured ERROR log for validation failure with COMPACTION_VALIDATION_FAILED code", () => {
    const err = codedError("Missing goal", "COMPACTION_VALIDATION_FAILED");
    logger.error("Compaction artifact validation failed", { errors: ["Missing goal"] }, err);
    expect(buffer).toHaveLength(1);
    expect(buffer[0].error?.code).toBe("COMPACTION_VALIDATION_FAILED");
  });

  it("emits a structured shared result-budget overflow", () => {
    const err = codedError("Budget exceeded", "COMPACTION_BUDGET_OVERFLOW");
    logger.warn("Compaction result budget exceeded", { budget: 10000, actual: 12000 }, err);
    expect(buffer).toHaveLength(1);
    expect(buffer[0].error?.code).toBe("COMPACTION_BUDGET_OVERFLOW");
  });
});
