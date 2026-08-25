import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestLogger } from "../../../../lib/logger/test-logger.js";

process.env.PI_LOG_LEVEL = "INFO";

describe("observability extension structured logging", () => {
  const { logger, buffer, clear, setSessionId } = createTestLogger("observability");

  beforeEach(() => {
    clear();
    setSessionId("obs-session-456");
  });

  afterEach(() => clear());

  it("emits a typed startup failure without WebSocket/Python error codes", () => {
    const error = Object.assign(new Error("service build missing"), {
      code: "OBSERVABILITY_SERVER_SPAWN_FAILED" as const,
    });
    logger.warn("TypeScript observability service is not built", {}, error);
    expect(buffer).toHaveLength(1);
    expect(buffer[0].error?.code).toBe("OBSERVABILITY_SERVER_SPAWN_FAILED");
    expect(buffer[0].sessionId).toBe("obs-session-456");
  });

  it("emits structured service lifecycle metadata", () => {
    logger.info("TypeScript observability service started", { transport: "http" });
    expect(buffer).toHaveLength(1);
    expect(buffer[0].level).toBe(1);
    expect(buffer[0].context).toEqual({ transport: "http" });
  });
});
