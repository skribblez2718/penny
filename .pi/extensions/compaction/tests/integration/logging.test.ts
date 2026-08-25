import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger, setSessionId, type ErrorCode } from "../../../../lib/logger/logger.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function codedError(message: string, code: ErrorCode): Error & { code: ErrorCode } {
  return Object.assign(new Error(message), { code });
}

describe("compaction integration logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.PI_LOG_LEVEL;
    delete process.env.PI_LOG_FORMAT;
  });

  it("emits JSON to observability REST endpoint with error code for validation failure", async () => {
    const fetchSpy = vi.fn<typeof fetch>(() => Promise.resolve(new Response()));
    vi.stubGlobal("fetch", fetchSpy);

    const logger = createLogger("compaction");
    setSessionId("compact-int-004");
    const err = codedError("Invalid artifact", "COMPACTION_VALIDATION_FAILED");
    logger.error("Validation failed", { errors: ["Invalid artifact"] }, err);

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const request = fetchSpy.mock.calls.at(0);
    if (request === undefined) {
      throw new Error("Expected one observability request");
    }
    const [url, options] = request;
    if (options === undefined) {
      throw new Error("Expected observability request options");
    }
    if (typeof options.body !== "string") {
      throw new TypeError("Expected observability request body to be a string");
    }

    expect(url).toBe("http://localhost:8765/logs");
    expect(options.method).toBe("POST");

    const body = requireRecord(JSON.parse(options.body), "Observability request body");
    const data = requireRecord(body.data, "Observability request data");
    const error = requireRecord(data.error, "Observability request error");
    expect(body.level).toBe("ERROR");
    expect(body.component).toBe("compaction");
    expect(body.session_id).toBe("compact-int-004");
    expect(body.event).toBe("Validation failed");
    expect(error.code).toBe("COMPACTION_VALIDATION_FAILED");
    expect(data.errors).toEqual(["Invalid artifact"]);
  });
});
