import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger, setSessionId } from "../../../../lib/logger/logger.js";
import {
  parseJson,
  requireArrayElement,
  requireRecord,
  requireString,
} from "../../../../lib/tests/test-narrowers.js";

describe("subagent integration logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.PI_LOG_LEVEL;
    delete process.env.PI_LOG_FORMAT;
  });

  it("emits JSON to observability REST endpoint for agent spawn error with sessionId", async () => {
    const fetchSpy = vi.fn((_url: string, _options?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 200 }))
    );
    vi.stubGlobal("fetch", fetchSpy);

    const logger = createLogger("agent-runner");
    setSessionId("agent-int-005");
    const err = Object.assign(new Error("ENOENT"), { code: "AGENT_SPAWN_ERROR" as const });
    logger.error("Spawn failed", { agent: "echo" }, err);

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const [url, options] = requireArrayElement(
      fetchSpy.mock.calls,
      0,
      "subagent log request was not sent"
    );
    expect(url).toBe("http://localhost:8765/logs");
    expect(options?.method).toBe("POST");

    const bodyText = requireString(options?.body, "subagent log body was not text");
    const body = requireRecord(parseJson(bodyText), "subagent log body was not an object");
    const data = requireRecord(body.data, "subagent log body omitted data");
    const error = requireRecord(data.error, "subagent log body omitted error data");
    expect(body.level).toBe("ERROR");
    expect(body.component).toBe("agent-runner");
    expect(body.session_id).toBe("agent-int-005");
    expect(body.event).toBe("Spawn failed");
    expect(error.code).toBe("AGENT_SPAWN_ERROR");
    expect(data.agent).toBe("echo");
  });
});
