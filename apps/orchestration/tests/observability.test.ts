import { describe, expect, it, vi } from "vitest";

import { ObservabilityClient } from "../src/observability.js";

const identity = {
  schema_version: 2 as const,
  run_id: "obs-run",
  session_id: "obs-session",
  playbook: "research",
  engine_owner: "typescript" as const,
};

function observation(eventType = "run_started") {
  return {
    identity,
    status: "running",
    stateId: "planning",
    eventType,
    payload: {
      run_id: identity.run_id,
      goal_sha256: "a".repeat(64),
      goal_bytes: 24,
    },
    sequence: 1,
    timestamp: "2026-08-16T00:00:00.000Z",
  };
}

describe("TypeScript orchestration observability mirror", () => {
  it("emits digest-only correlated run and event payloads", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const client = new ObservabilityClient({
      env: { PI_OBSERVABILITY_REST_URL: "http://observability.test" },
      fetchImpl,
      timeoutMs: 100,
    });
    client.observe(observation());
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((call) => call.url)).toEqual([
      "http://observability.test/orchestration/runs",
      "http://observability.test/orchestration/events",
    ]);
    expect(JSON.stringify(calls)).not.toContain("PRIVATE_RAW_GOAL");
    expect(calls[0]!.body).toContain("goal_sha256");
    expect(calls[1]!.body).toContain("obs-session");
  });

  it("opens a fail-silent circuit after an outage", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("server down");
    }) as unknown as typeof fetch;
    const client = new ObservabilityClient({ fetchImpl, timeoutMs: 10 });
    expect(() => client.observe(observation("phase_result_accepted"))).not.toThrow();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    client.observe({ ...observation("run_cancelled"), sequence: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
