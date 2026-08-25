import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger, setSessionId } from "../../../../lib/logger/logger.js";
import {
  parseJson,
  requireArrayElement,
  requireRecord,
  requireString,
} from "../../../../lib/tests/test-narrowers.js";

describe("observability integration logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.PI_LOG_LEVEL;
    delete process.env.PI_LOG_FORMAT;
  });

  it("sends structured logs over the canonical HTTP transport", async () => {
    const fetchSpy = vi.fn((_url: string, _options?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 200 }))
    );
    vi.stubGlobal("fetch", fetchSpy);

    const logger = createLogger("observability");
    setSessionId("obs-int-003");
    logger.error("Service request failed", {}, new Error("Connection refused"));

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const [url, options] = requireArrayElement(
      fetchSpy.mock.calls,
      0,
      "observability log request was not sent"
    );
    expect(url).toBe("http://localhost:8765/logs");
    expect(options?.method).toBe("POST");

    const bodyText = requireString(options?.body, "observability log body was not text");
    const body = requireRecord(parseJson(bodyText), "observability log body was not an object");
    const data = requireRecord(body.data, "observability log body omitted data");
    const error = requireRecord(data.error, "observability log body omitted error data");
    expect(body.level).toBe("ERROR");
    expect(body.component).toBe("observability");
    expect(body.session_id).toBe("obs-int-003");
    expect(body.event).toBe("Service request failed");
    expect(error.name).toBe("Error");
    expect(error.code).toBeUndefined(); // No code forced in this generic test
  });
});
