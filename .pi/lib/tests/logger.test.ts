import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LOGGER_ENVIRONMENT_NAMES = [
  "PI_LOG_LEVEL",
  "PI_LOG_LEVEL_LOAD_TIMING",
  "PI_LOG_LEVEL_PRECEDENCE",
  "PI_LOG_FORMAT",
  "PI_OBSERVABILITY_REST_URL",
  "PI_OBSERVABILITY_API_KEY",
  "PENNY_OBSERVABILITY_API_KEY",
] as const;

const ORIGINAL_ENVIRONMENT = process.env;

interface RecordedRequest {
  url: string;
  init: RequestInit;
  body: unknown;
}

function clearLoggerEnvironment(): void {
  for (const name of LOGGER_ENVIRONMENT_NAMES) delete process.env[name];
}

function setEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function successfulFetchSpy() {
  return vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 204 })));
}

function recordedRequest(
  calls: ReadonlyArray<readonly [input: string | URL | Request, init?: RequestInit]>,
  index: number = 0
): RecordedRequest {
  const call = calls[index];
  if (call === undefined) throw new Error(`fetch call ${index} was not recorded`);
  const [input, init] = call;
  if (typeof input !== "string") throw new Error(`fetch call ${index} did not use a string URL`);
  if (init === undefined) throw new Error(`fetch call ${index} omitted request options`);
  if (typeof init.body !== "string") throw new Error(`fetch call ${index} omitted a JSON body`);
  const body: unknown = JSON.parse(init.body);
  return { url: input, init, body };
}

function requireEntry(entries: readonly string[], index: number = 0): string {
  const entry = entries[index];
  if (entry === undefined) throw new Error(`log entry ${index} was not emitted`);
  return entry;
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENVIRONMENT };
  clearLoggerEnvironment();
  vi.resetModules();
});

afterEach(() => {
  process.env = ORIGINAL_ENVIRONMENT;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("shared logger runtime configuration", () => {
  it("does not read environment during import or construction and uses it on the first message", async () => {
    process.env.PI_LOG_LEVEL = "ERROR";
    process.env.PI_LOG_LEVEL_LOAD_TIMING = "ERROR";
    process.env.PI_LOG_FORMAT = "json";
    process.env.PI_OBSERVABILITY_REST_URL = "https://before-import.example.test";
    process.env.PI_OBSERVABILITY_API_KEY = "before-import-key";

    const reads: string[] = [];
    const trackedNames: ReadonlySet<string> = new Set(LOGGER_ENVIRONMENT_NAMES);
    process.env = new Proxy(process.env, {
      get(target, property) {
        if (typeof property !== "string") return undefined;
        if (trackedNames.has(property)) reads.push(property);
        return target[property];
      },
    });

    const { createLogger } = await import("../logger/logger.js");
    expect(reads).toEqual([]);

    const entries: string[] = [];
    const logger = createLogger("load-timing", (entry) => entries.push(entry));
    expect(reads).toEqual([]);

    process.env.PI_LOG_LEVEL = "CRITICAL";
    process.env.PI_LOG_LEVEL_LOAD_TIMING = "INFO";
    process.env.PI_LOG_FORMAT = "text";
    reads.length = 0;

    logger.info("configured after construction");

    expect(reads).toContain("PI_LOG_LEVEL_LOAD_TIMING");
    expect(reads).toContain("PI_LOG_FORMAT");
    expect(entries).toHaveLength(1);
    expect(requireEntry(entries)).toMatch(
      /^\[[^\]]+\] \[INFO\] \[load-timing\] configured after construction$/u
    );
  });

  it("uses the runtime REST URL and primary API key after import and construction", async () => {
    process.env.PI_OBSERVABILITY_REST_URL = "https://before-import.example.test";
    process.env.PI_OBSERVABILITY_API_KEY = "before-import-key";

    const { createLogger } = await import("../logger/logger.js");
    const logger = createLogger("rest-load-timing");
    const fetchSpy = successfulFetchSpy();
    vi.stubGlobal("fetch", fetchSpy);

    process.env.PI_OBSERVABILITY_REST_URL = "https://runtime.example.test/ingest/";
    process.env.PI_OBSERVABILITY_API_KEY = "runtime-primary-key";
    process.env.PENNY_OBSERVABILITY_API_KEY = "runtime-legacy-key";

    logger.error("runtime REST configuration");

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const request = recordedRequest(fetchSpy.mock.calls);
    expect(request.url).toBe("https://runtime.example.test/ingest/logs");
    expect(new Headers(request.init.headers).get("Authorization")).toBe(
      "Bearer runtime-primary-key"
    );
    expect(request.body).toMatchObject({
      level: "ERROR",
      component: "rest-load-timing",
      event: "runtime REST configuration",
    });
  });

  it.each([
    {
      label: "missing URL and keys",
      url: undefined,
      primaryKey: undefined,
      legacyKey: undefined,
      authorization: null,
    },
    {
      label: "invalid URL and empty primary key",
      url: "ftp://invalid.example.test",
      primaryKey: "",
      legacyKey: "legacy-key",
      authorization: "Bearer legacy-key",
    },
  ])("uses REST defaults for $label", async ({ url, primaryKey, legacyKey, authorization }) => {
    setEnvironment("PI_OBSERVABILITY_REST_URL", url);
    setEnvironment("PI_OBSERVABILITY_API_KEY", primaryKey);
    setEnvironment("PENNY_OBSERVABILITY_API_KEY", legacyKey);

    const fetchSpy = successfulFetchSpy();
    vi.stubGlobal("fetch", fetchSpy);
    const { createLogger } = await import("../logger/logger.js");

    createLogger("rest-defaults").error("default REST configuration");

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const request = recordedRequest(fetchSpy.mock.calls);
    expect(request.url).toBe("http://localhost:8765/logs");
    expect(new Headers(request.init.headers).get("Authorization")).toBe(authorization);
  });

  it("preserves component-level precedence and text formatting", async () => {
    process.env.PI_LOG_LEVEL = "ERROR";
    process.env.PI_LOG_LEVEL_PRECEDENCE = "INFO";
    process.env.PI_LOG_FORMAT = "text";
    const { createLogger } = await import("../logger/logger.js");
    const entries: string[] = [];

    createLogger("precedence", (entry) => entries.push(entry)).info("component override", {
      source: "test",
    });

    expect(entries).toHaveLength(1);
    expect(requireEntry(entries)).toMatch(
      /^\[[^\]]+\] \[INFO\] \[precedence\] component override \{source=test\}$/u
    );
  });

  it("keeps WARN and JSON as the missing-value defaults", async () => {
    const { createLogger } = await import("../logger/logger.js");
    const entries: string[] = [];
    const logger = createLogger("defaults", (entry) => entries.push(entry));

    logger.info("filtered by default");
    logger.warn("default warning");

    expect(entries).toHaveLength(1);
    const parsedEntry: unknown = JSON.parse(requireEntry(entries));
    expect(parsedEntry).toMatchObject({
      level: 2,
      extension: "defaults",
      message: "default warning",
    });
  });

  it("warns through REST and falls back for invalid level and format values", async () => {
    process.env.PI_LOG_LEVEL = "verbose";
    process.env.PI_LOG_FORMAT = "yaml";
    const fetchSpy = successfulFetchSpy();
    vi.stubGlobal("fetch", fetchSpy);
    const { createLogger } = await import("../logger/logger.js");
    const entries: string[] = [];

    createLogger("invalid-config", (entry) => entries.push(entry)).warn("fallback output");

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const levelWarning = recordedRequest(fetchSpy.mock.calls, 0);
    const formatWarning = recordedRequest(fetchSpy.mock.calls, 1);
    expect(levelWarning.url).toBe("http://localhost:8765/logs");
    expect(levelWarning.body).toMatchObject({
      level: "WARN",
      component: "logger",
      event: 'Invalid PI_LOG_LEVEL "verbose" — using WARN',
    });
    expect(formatWarning.body).toMatchObject({
      level: "WARN",
      component: "logger",
      event: 'Invalid PI_LOG_FORMAT "yaml" — using json',
    });

    const parsedEntry: unknown = JSON.parse(requireEntry(entries));
    expect(parsedEntry).toMatchObject({
      level: 2,
      extension: "invalid-config",
      message: "fallback output",
    });
  });

  it("retains the REST failure circuit breaker", async () => {
    const fetchSpy = vi.fn<typeof fetch>(() =>
      Promise.reject(new Error("observability unavailable"))
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { createLogger } = await import("../logger/logger.js");
    const logger = createLogger("circuit-breaker");

    logger.error("first failure");
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    logger.error("suppressed retry");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
