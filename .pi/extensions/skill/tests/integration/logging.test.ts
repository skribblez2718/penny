import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger, setSessionId } from "../../../../lib/logger/logger.js";

describe("skill integration logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.PI_LOG_LEVEL;
    delete process.env.PI_LOG_FORMAT;
  });

  it("sends text format log to observability REST endpoint when PI_LOG_FORMAT=text", async () => {
    process.env.PI_LOG_FORMAT = "text";
    const fetchSpy = vi.fn((_url: string, _options?: RequestInit) => Promise.resolve({ ok: true } as Response));
    vi.stubGlobal("fetch", fetchSpy);

    const logger = createLogger("skill");
    setSessionId("skill-int-002");
    logger.error("Python timeout", { step: "start" });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:8765/logs");
    expect(options?.method).toBe("POST");

    const body = JSON.parse(options?.body as string);
    expect(body.level).toBe("INFO"); // text format falls back to INFO
    expect(body.component).toBe("unknown"); // text format can't parse extension
    expect(body.event).toContain("Python timeout");
    expect(body.event).toContain("[skill]");
    expect(body.event).toContain("sessionId=");
    expect(body.data._format).toBe("text");
  });
});
