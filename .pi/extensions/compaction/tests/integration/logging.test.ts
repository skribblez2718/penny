import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger, setSessionId } from "../../../../lib/logger/logger.js";

describe("compaction integration logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.PI_LOG_LEVEL;
    delete process.env.PI_LOG_FORMAT;
  });

  it("emits JSON to observability REST endpoint with error code for validation failure", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true } as Response));
    vi.stubGlobal("fetch", fetchSpy);

    const logger = createLogger("compaction");
    setSessionId("compact-int-004");
    const err = Object.assign(new Error("Invalid artifact"), {
      code: "COMPACTION_VALIDATION_FAILED",
    });
    logger.error("Validation failed", { errors: ["Invalid artifact"] }, err);

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:8765/logs");
    expect(options?.method).toBe("POST");

    const body = JSON.parse(options?.body as string);
    expect(body.level).toBe("ERROR");
    expect(body.component).toBe("compaction");
    expect(body.session_id).toBe("compact-int-004");
    expect(body.event).toBe("Validation failed");
    expect(body.data.error.code).toBe("COMPACTION_VALIDATION_FAILED");
    expect(body.data.errors).toEqual(["Invalid artifact"]);
  });
});
