import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { pennyStatePaths, provisionObservabilityDatabase } from "@penny/orchestration/source";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ObservabilityServiceStarter } from "../../service-startup.js";

const roots: string[] = [];
const childPids: number[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  );
  return address.port;
}

async function waitUntilUnavailable(baseUrl: string): Promise<void> {
  await vi.waitFor(
    async () => {
      await expect(fetch(`${baseUrl}/health`)).rejects.toThrow();
    },
    { timeout: 5_000, interval: 50 }
  );
}

afterEach(async () => {
  for (const pid of childPids.splice(0)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process may already have exited.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("built observability service startup", () => {
  it("keeps the detached built service alive after its starter parent exits", async () => {
    const projectRoot = path.resolve(import.meta.dirname, "../../../../../");
    const stateRoot = mkdtempSync(path.join(tmpdir(), "penny-observability-parent-exit-"));
    roots.push(stateRoot);
    const state = pennyStatePaths(stateRoot);
    mkdirSync(state.observability.root, { recursive: true, mode: 0o700 });
    provisionObservabilityDatabase(state.observability.database);

    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const launcherPath = path.join(stateRoot, "launch.mjs");
    const resultPath = path.join(stateRoot, "startup-result.json");
    const startupModuleUrl = pathToFileURL(
      path.join(projectRoot, ".pi", "extensions", "observability", "service-startup.ts")
    ).href;
    writeFileSync(
      launcherPath,
      [
        'import { writeFileSync } from "node:fs";',
        `import { ObservabilityServiceStarter } from ${JSON.stringify(startupModuleUrl)};`,
        "const starter = new ObservabilityServiceStarter({",
        `  projectRoot: ${JSON.stringify(projectRoot)},`,
        `  baseUrl: ${JSON.stringify(baseUrl)},`,
        "  env: process.env,",
        "});",
        "const result = await starter.ensureReady();",
        `writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));`,
        "if (!result.ready) process.exitCode = 1;",
      ].join("\n")
    );

    const launcher = spawnSync(process.execPath, [launcherPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PENNY_STATE_ROOT: stateRoot,
        PI_OBSERVABILITY_HOST: "127.0.0.1",
        PI_OBSERVABILITY_PORT: String(port),
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(launcher.error).toBeUndefined();
    expect(launcher.status, launcher.stderr).toBe(0);

    const parsed: unknown = JSON.parse(readFileSync(resultPath, "utf8"));
    if (!isRecord(parsed) || parsed.ready !== true || typeof parsed.childPid !== "number") {
      throw new Error("launcher did not return a detached child PID");
    }
    childPids.push(parsed.childPid);
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);

    process.kill(parsed.childPid, "SIGTERM");
    childPids.splice(childPids.indexOf(parsed.childPid), 1);
    await waitUntilUnavailable(baseUrl);
  });

  it("starts the built service through the real detached spawn path and confirms health", async () => {
    const projectRoot = path.resolve(import.meta.dirname, "../../../../../");
    const entryPath = path.join(projectRoot, "apps", "observability", "dist", "server.js");
    const stateRoot = mkdtempSync(path.join(tmpdir(), "penny-observability-detached-"));
    roots.push(stateRoot);
    const state = pennyStatePaths(stateRoot);
    mkdirSync(state.observability.root, { recursive: true, mode: 0o700 });
    provisionObservabilityDatabase(state.observability.database);

    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const spawnService = vi.fn((...parameters: Parameters<typeof spawn>) => spawn(...parameters));
    const starter = new ObservabilityServiceStarter({
      projectRoot,
      baseUrl,
      entryPath,
      env: {
        ...process.env,
        PENNY_STATE_ROOT: stateRoot,
        PI_OBSERVABILITY_HOST: "127.0.0.1",
        PI_OBSERVABILITY_PORT: String(port),
      },
      spawnService,
    });

    const first = starter.ensureReady();
    const concurrent = starter.ensureReady();
    expect(starter.isReady).toBe(false);
    const [result, concurrentResult] = await Promise.all([first, concurrent]);

    expect(result).toMatchObject({ ready: true, spawned: true });
    expect(concurrentResult).toMatchObject({ ready: true, spawned: true });
    expect(spawnService).toHaveBeenCalledTimes(1);
    expect(starter.isReady).toBe(true);
    if (!result.ready || result.childPid === undefined)
      throw new Error("detached child PID is missing");
    childPids.push(result.childPid);

    const health: unknown = await (await fetch(`${baseUrl}/health`)).json();
    if (!isRecord(health)) throw new Error("health response is not an object");
    expect(health).toMatchObject({ ok: true, service: "penny-observability" });

    process.kill(result.childPid, "SIGTERM");
    childPids.splice(childPids.indexOf(result.childPid), 1);
    await waitUntilUnavailable(baseUrl);
  });
});
