import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ObservabilityServiceStarter,
  observabilityServiceAlive,
  sanitizeStartupStderr,
} from "../../service-startup.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-observability-startup-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("observability detached service startup", () => {
  it("coalesces concurrent attempts, bounds and sanitizes stderr, and permits retry", async () => {
    const root = temporaryRoot();
    const entry = path.join(root, "failing-service.mjs");
    const marker = path.join(root, "spawn-count.txt");
    const secret = "diagnostic-secret-value";
    writeFileSync(
      entry,
      [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(marker)}, "spawned\\n");`,
        `process.stderr.write("API_KEY=${secret} Bearer visible-token " + "x".repeat(1024));`,
        "process.exitCode = 17;",
      ].join("\n"),
      { mode: 0o700 }
    );

    const spawnService = vi.fn((...parameters: Parameters<typeof spawn>) => spawn(...parameters));
    const starter = new ObservabilityServiceStarter({
      projectRoot: root,
      baseUrl: "http://127.0.0.1:1",
      entryPath: entry,
      env: { ...process.env, TEST_API_KEY: secret },
      startupTimeoutMs: 2_000,
      pollIntervalMs: 10,
      stderrMaxBytes: 128,
      spawnService,
      fetchImplementation: vi.fn(async () => {
        throw new Error("offline");
      }),
    });

    const [first, concurrent] = await Promise.all([starter.ensureReady(), starter.ensureReady()]);
    expect(first.ready).toBe(false);
    expect(concurrent.ready).toBe(false);
    expect(spawnService).toHaveBeenCalledTimes(1);
    expect(starter.isReady).toBe(false);
    if (first.ready) throw new Error("expected startup failure");
    expect(first.exitCode).toBe(17);
    expect(first.stderrTruncated).toBe(true);
    expect(first.stderr).toContain("API_KEY=[REDACTED]");
    expect(first.stderr).toContain("Bearer [REDACTED]");
    expect(first.stderr).not.toContain(secret);
    expect(first.stderr).not.toContain("visible-token");
    expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);

    const retry = await starter.ensureReady();
    expect(retry.ready).toBe(false);
    expect(spawnService).toHaveBeenCalledTimes(2);
    expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(2);

    const options = spawnService.mock.calls[0]?.[2];
    expect(options).toMatchObject({
      cwd: root,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { PI_OBSERVABILITY_HOST: "127.0.0.1", PI_OBSERVABILITY_PORT: "1" },
    });
    const spawnedEnvironment = options?.env;
    if (!spawnedEnvironment) throw new Error("spawn environment is missing");
    expect(spawnedEnvironment.TEST_API_KEY).toBeUndefined();
  });

  it("terminates a spawned child that misses the readiness deadline", async () => {
    const root = temporaryRoot();
    const entry = path.join(root, "unhealthy-service.mjs");
    writeFileSync(
      entry,
      "process.on('SIGTERM', () => process.exit(0)); setInterval(() => undefined, 1000);\n",
      {
        mode: 0o700,
      }
    );
    const starter = new ObservabilityServiceStarter({
      projectRoot: root,
      baseUrl: "http://127.0.0.1:1",
      entryPath: entry,
      startupTimeoutMs: 30,
      pollIntervalMs: 5,
      fetchImplementation: vi.fn(async () => {
        throw new Error("offline");
      }),
    });

    const result = await starter.ensureReady();
    expect(result.ready).toBe(false);
    const childPid = result.childPid;
    if (result.ready || childPid === undefined) throw new Error("failed child PID is missing");
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it("marks the service ready only after health confirmation", async () => {
    const root = temporaryRoot();
    const entry = path.join(root, "waiting-service.mjs");
    writeFileSync(entry, "setInterval(() => undefined, 1000);\n", { mode: 0o700 });
    let healthChecks = 0;
    const starter = new ObservabilityServiceStarter({
      projectRoot: root,
      baseUrl: "http://127.0.0.1:1",
      entryPath: entry,
      startupTimeoutMs: 2_000,
      pollIntervalMs: 10,
      fetchImplementation: vi.fn(async () => {
        healthChecks += 1;
        if (healthChecks < 3) throw new Error("not ready");
        return Response.json({ ok: true, service: "penny-observability", schema_version: 1 });
      }),
    });

    const pending = starter.ensureReady();
    expect(starter.isReady).toBe(false);
    const result = await pending;
    expect(result.ready).toBe(true);
    expect(starter.isReady).toBe(true);
    expect(healthChecks).toBeGreaterThanOrEqual(3);
    if (result.ready && result.childPid !== undefined) process.kill(result.childPid, "SIGTERM");
  });

  it("requires the expected typed health identity", async () => {
    const wrongService = vi.fn(async () => Response.json({ ok: true, service: "other" }));
    const malformed = vi.fn(async () => new Response("ok", { status: 200 }));
    expect(await observabilityServiceAlive("http://127.0.0.1:8765", wrongService)).toBe(false);
    expect(await observabilityServiceAlive("http://127.0.0.1:8765", malformed)).toBe(false);
  });

  it("rejects unbounded startup options and non-loopback endpoints", () => {
    const root = temporaryRoot();
    const options = { projectRoot: root, baseUrl: "http://127.0.0.1:8765" };
    expect(
      () =>
        new ObservabilityServiceStarter({ ...options, startupTimeoutMs: Number.POSITIVE_INFINITY })
    ).toThrow(/startupTimeoutMs/u);
    expect(() => new ObservabilityServiceStarter({ ...options, pollIntervalMs: 0 })).toThrow(
      /pollIntervalMs/u
    );
    expect(
      () => new ObservabilityServiceStarter({ ...options, stderrMaxBytes: Number.NaN })
    ).toThrow(/stderrMaxBytes/u);
    expect(
      () =>
        new ObservabilityServiceStarter({
          projectRoot: root,
          baseUrl: "https://observability.example.test",
        })
    ).toThrow(/loopback HTTP origin/u);
  });

  it("redacts common credentials and terminal-sanitizes C0 and C1 controls", () => {
    const secret = "long-enough-secret";
    const result = sanitizeStartupStderr(
      [
        `token=${secret}\u001b[31m\u009b`,
        "Authorization: Basic dXNlcjpzdXBlcnNlY3JldA==",
        "Cookie: session=private-value",
        "https://user:password@example.test/path?access_token=query-secret",
      ].join("\n"),
      { TOKEN_VALUE: secret }
    );
    expect(result).not.toContain(secret);
    expect(result).not.toContain("dXNlcjpzdXBlcnNlY3JldA==");
    expect(result).not.toContain("private-value");
    expect(result).not.toContain("user:password");
    expect(result).not.toContain("query-secret");
    expect(result).not.toContain("\u001b");
    expect(result).not.toContain("\u009b");
  });
});
