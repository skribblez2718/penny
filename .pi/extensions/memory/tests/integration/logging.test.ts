import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger, setSessionId } from "../../../../lib/logger/logger.js";

describe("memory integration logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.PI_LOG_LEVEL;
    delete process.env.PI_LOG_FORMAT;
  });

  it("emits JSON structured log to observability REST endpoint for bridge timeout", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true } as Response));
    vi.stubGlobal("fetch", fetchSpy);

    const logger = createLogger("memory");
    setSessionId("mem-int-001");
    logger.error("Bridge timeout", { tool: "status" }, new Error("timeout"));

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:8765/logs");
    expect(options?.method).toBe("POST");

    const body = JSON.parse(options?.body as string);
    expect(body.level).toBe("ERROR");
    expect(body.component).toBe("memory");
    expect(body.session_id).toBe("mem-int-001");
    expect(body.event).toBe("Bridge timeout");
    expect(body.data.error.name).toBe("Error");
    expect(body.data.tool).toBe("status");
    expect(body.client_id).toBe("penny-extension");
  });
});
