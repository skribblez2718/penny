import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createObservabilityServer } from "../src/server.js";

const roots: string[] = [];

function fixture(apiKey = "") {
  const root = mkdtempSync(path.join(tmpdir(), "penny-observability-"));
  roots.push(root);
  const directory = path.join(root, "observability");
  mkdirSync(directory, { mode: 0o700 });
  const created = createObservabilityServer({
    databasePath: path.join(directory, "observability.db"),
    apiKey,
    maxRows: 100,
  });
  return created;
}

async function listen(server: ReturnType<typeof fixture>["server"]): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof fixture>["server"]): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function jsonObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error("expected a JSON object response");
  return value;
}

function recordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const records: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (!isRecord(item)) throw new Error(`${label} must contain objects`);
    records.push(item);
  }
  return records;
}

function errorMessage(payload: Record<string, unknown>): string {
  if (typeof payload.error !== "string") throw new Error("expected a string error response");
  return payload.error;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reduced TypeScript observability service", () => {
  it("preserves valid log writes, open POST objects, and query filtering", async () => {
    const { server } = fixture();
    const base = await listen(server);
    const inserted = await fetch(`${base}/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        timestamp: 1_700_000_000_000,
        level: "WARN",
        component: "subagent",
        event: "worker delayed",
        session_id: "session-1",
        data: { code: "DELAY" },
        future_field: { accepted: true },
      }),
    });
    expect(inserted.status).toBe(201);
    expect(await jsonObject(inserted)).toEqual({ id: 1 });

    const queried = await fetch(
      `${base}/logs?component=subagent&session_id=session-1&level=warn&from_ts=1699999999999&to_ts=1700000000001&limit=10&offset=0`
    );
    expect(queried.status).toBe(200);
    const payload = await jsonObject(queried);
    expect(payload.limit).toBe(10);
    expect(payload.offset).toBe(0);
    const logs = recordArray(payload.logs, "logs");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: "WARN",
      component: "subagent",
      event: "worker delayed",
      session_id: "session-1",
      data_json: '{"code":"DELAY"}',
    });
    expect(logs[0]).not.toHaveProperty("future_field");
    await close(server);
  });

  it("preserves auth envelopes and rejects malformed, missing, and wrong-type log bodies", async () => {
    const { server } = fixture("secret");
    const base = await listen(server);
    for (let index = 0; index < 100; index += 1) {
      const response = await fetch(`${base}/logs`, {
        method: "POST",
        headers: { authorization: "Bearer wrong", "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(401);
      expect(await jsonObject(response)).toEqual({ error: "unauthorized" });
    }

    const invalidBodies = [
      '{"level":',
      JSON.stringify({ component: "search", event: "missing level" }),
      JSON.stringify({ level: "INFO", component: 42, event: "wrong component" }),
      JSON.stringify([]),
    ];
    for (const body of invalidBodies) {
      const response = await fetch(`${base}/logs`, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(400);
      expect(errorMessage(await jsonObject(response))).not.toBe("");
    }

    const healthResponse = await fetch(`${base}/health`);
    expect(healthResponse.status).toBe(200);
    const health = await jsonObject(healthResponse);
    if (!isRecord(health.counts)) throw new Error("health counts are missing");
    expect(health.counts).toEqual({ logs: 0, compactions: 0 });
    await close(server);
  });

  it("preserves valid compactions while rejecting missing and wrong-type known fields", async () => {
    const { server, database } = fixture();
    const base = await listen(server);
    const response = await fetch(`${base}/compactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "session-2",
        summary: "bounded summary",
        future_field: "ignored",
      }),
    });
    expect(response.status).toBe(201);
    expect(await jsonObject(response)).toEqual({ id: 1 });

    for (const body of [
      JSON.stringify({ session_id: "session-2" }),
      JSON.stringify({ session_id: false, summary: "wrong session" }),
    ]) {
      const invalid = await fetch(`${base}/compactions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(invalid.status).toBe(400);
      expect(errorMessage(await jsonObject(invalid))).not.toBe("");
    }
    expect(database.counts()).toEqual({ logs: 0, compactions: 1 });
    await close(server);
  });

  it("preserves query, not-found, and validation error envelopes", async () => {
    const { server } = fixture();
    const base = await listen(server);

    const invalidQuery = await fetch(`${base}/logs?limit=0`);
    expect(invalidQuery.status).toBe(400);
    expect(await jsonObject(invalidQuery)).toEqual({
      error: "limit must be an integer from 1 through 500",
    });

    const missing = await fetch(`${base}/unknown`);
    expect(missing.status).toBe(404);
    expect(await jsonObject(missing)).toEqual({ error: "not_found" });
    await close(server);
  });
});
