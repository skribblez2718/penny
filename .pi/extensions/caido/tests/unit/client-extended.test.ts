import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  classifyCaidoError,
  loadConfig,
  InMemoryTokenCache,
  getClient,
  resetClient,
  withCaidoClient,
  type WithCaidoClientDeps,
} from "../../client.js";
import type { CaidoConfig } from "../../types.js";

// ── InMemoryTokenCache ──
describe("InMemoryTokenCache", () => {
  let cache: InMemoryTokenCache;

  beforeEach(() => {
    cache = new InMemoryTokenCache();
  });

  it("returns undefined when empty", async () => {
    const token = await cache.load();
    expect(token).toBeUndefined();
  });

  it("returns saved token", async () => {
    const saved = { accessToken: "abc123", expiresAt: "2025-01-01T00:00:00Z" };
    await cache.save(saved);
    const loaded = await cache.load();
    expect(loaded).toEqual(saved);
  });

  it("clears stored token", async () => {
    await cache.save({ accessToken: "abc123" });
    await cache.clear();
    const loaded = await cache.load();
    expect(loaded).toBeUndefined();
  });
});

// ── getClient singleton ──
vi.mock("@caido/sdk-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@caido/sdk-client")>();
  return {
    ...mod,
    Client: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

describe("getClient", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.CAIDO_PAT = "test-pat";
    process.env.CAIDO_URL = "http://localhost:8080";
    resetClient();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  it("returns same instance on multiple calls (singleton)", async () => {
    const { Client } = await import("@caido/sdk-client");
    const c1 = await getClient();
    const c2 = await getClient();
    expect(c1).toBe(c2);
    expect(Client).toHaveBeenCalledTimes(1);
  });

  it("creates new client after resetClient", async () => {
    const { Client } = await import("@caido/sdk-client");
    await getClient();
    resetClient();
    await getClient();
    expect(Client).toHaveBeenCalledTimes(2);
  });
});

// ── withCaidoClient ──

describe("withCaidoClient", () => {
  const mockConfig: CaidoConfig = { url: "http://localhost:8080", pat: "test-pat" };
  let deps: WithCaidoClientDeps;
  let acquireCount: number;
  let releaseCount: number;

  beforeEach(() => {
    acquireCount = 0;
    releaseCount = 0;
    deps = {
      acquireSemaphore: vi.fn().mockImplementation(async () => {
        acquireCount++;
      }),
      releaseSemaphore: vi.fn().mockImplementation(() => {
        releaseCount++;
      }),
      logger: { error: vi.fn() },
    };
  });

  it("returns error when pat is empty", async () => {
    const result = await withCaidoClient("caido_test", { ...mockConfig, pat: "" }, deps, async () => "ok");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("CAIDO_PAT not set");
    expect(acquireCount).toBe(0);
    expect(releaseCount).toBe(0);
  });

  it("releases semaphore on success", async () => {
    const result = await withCaidoClient("caido_test", mockConfig, deps, async () => "ok");
    expect(result.isError).toBeUndefined();
    expect(acquireCount).toBe(1);
    expect(releaseCount).toBe(1);
  });

  it("releases semaphore on error", async () => {
    const result = await withCaidoClient("caido_test", mockConfig, deps, async () => {
      throw new Error("boom");
    });
    expect(result.isError).toBe(true);
    expect(acquireCount).toBe(1);
    expect(releaseCount).toBe(1);
  });

  it("handles string result directly", async () => {
    const result = await withCaidoClient("caido_test", mockConfig, deps, async () => "hello");
    expect(result.content[0].text).toBe("hello");
  });

  it("stringifies object result", async () => {
    const data = { id: 1, name: "test" };
    const result = await withCaidoClient("caido_test", mockConfig, deps, async () => data);
    expect(result.content[0].text).toBe(JSON.stringify(data, null, 2));
    expect(result.details).toEqual(data);
  });

  it("classifies raw ECONNREFUSED error as CONNECTION_REFUSED", async () => {
    const result = await withCaidoClient("caido_test", mockConfig, deps, async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cannot connect to Caido");
    expect(deps.logger.error).toHaveBeenCalledWith("caido_test failed", {
      error: "connect ECONNREFUSED 127.0.0.1:8080",
      category: "CONNECTION_REFUSED",
    });
  });

  it("classifies unknown errors with UNKNOWN category", async () => {
    const result = await withCaidoClient("caido_test", mockConfig, deps, async () => {
      throw new Error("Something weird happened");
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Something weird happened");
    expect(deps.logger.error).toHaveBeenCalledWith("caido_test failed", {
      error: "Something weird happened",
      category: "UNKNOWN",
    });
  });

  it("classifies non-Error throws", async () => {
    const result = await withCaidoClient("caido_test", mockConfig, deps, async () => {
      throw "plain string error";
    });
    expect(result.isError).toBe(true);
    expect(deps.logger.error).toHaveBeenCalledWith("caido_test failed", {
      error: "plain string error",
      category: "UNKNOWN",
    });
  });
});
