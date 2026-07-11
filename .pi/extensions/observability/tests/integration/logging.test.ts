import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger, setSessionId } from "../../../../lib/logger/logger.js";

describe("observability integration logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.PI_LOG_LEVEL;
    delete process.env.PI_LOG_FORMAT;
  });

  it("sends log via REST fallback for WebSocket error", async () => {
    const fetchSpy = vi.fn((_url: string, _options?: RequestInit) => Promise.resolve({ ok: true } as Response));
    vi.stubGlobal("fetch", fetchSpy);

    const logger = createLogger("observability");
    setSessionId("obs-int-003");
    logger.error("WebSocket error", {}, new Error("Connection refused"));

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:8765/logs");
    expect(options?.method).toBe("POST");

    const body = JSON.parse(options?.body as string);
    expect(body.level).toBe("ERROR");
    expect(body.component).toBe("observability");
    expect(body.session_id).toBe("obs-int-003");
    expect(body.event).toBe("WebSocket error");
    expect(body.data.error?.name).toBe("Error");
    expect(body.data.error?.code).toBeUndefined(); // No code forced in this generic test
  });
});
