import type { BigIntStats, PathLike, Stats, StatOptions } from "node:fs";
import { chmod, link, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SCA_SERVICE_ENV, validateScaServiceConfig } from "../src/config.js";
import { SCA_SERVICE_IPC_PROTOCOL } from "../src/router.js";
import { startScaService, type ScaServiceHandle } from "../src/server.js";

const TOKEN = "startup-test-token-00000000000000000000";
const roots = new Set<string>();
const services = new Set<ScaServiceHandle>();

async function temporarySocket(): Promise<{ root: string; socketPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "penny-sca-service-test-"));
  roots.add(root);
  return { root, socketPath: path.join(root, "service.sock") };
}

interface TestFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

async function socketIdentity(target: string): Promise<TestFileIdentity> {
  const stats = await lstat(target, { bigint: true });
  if (!stats.isSocket()) throw new Error("expected a socket filesystem entry");
  return { device: stats.dev, inode: stats.ino };
}

async function createForeignSocketEntry(target: string): Promise<TestFileIdentity> {
  const boundPath = path.join(path.dirname(target), ".foreign-bound.sock");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(boundPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
  try {
    await chmod(boundPath, 0o600);
    await link(boundPath, target);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  return await socketIdentity(target);
}

function capabilityFrame(token = TOKEN): Record<string, unknown> {
  const requestedAt = new Date(Date.now() - 1_000);
  const deadlineAt = new Date(Date.now() + 10_000);
  return {
    protocol: SCA_SERVICE_IPC_PROTOCOL,
    action: "capability",
    token,
    request: {
      schema_id: "penny.sca-broker-capability-request.v1",
      schema_version: 1,
      request_id: "startup-capability-source",
      tenant_id: "tenant-a",
      project_id: "project-a",
      run_id: "11111111-2222-4333-8444-555555555555",
      tool_name: "sca_source_query",
      operation: "source_query",
      requested_at: requestedAt.toISOString(),
      deadline_at: deadlineAt.toISOString(),
      timeout_ms: 1_000,
    },
  };
}

async function request(socketPath: string, payload: string): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let body = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("IPC response timed out"));
    }, 2_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(payload, "utf8"));
    socket.on("data", (chunk: string) => {
      body += chunk;
    });
    socket.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function connect(socketPath: string): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function trackedService(
  socketPath: string,
  overrides: Partial<Parameters<typeof startScaService>[0]> = {}
): Promise<ScaServiceHandle> {
  const service = await startScaService({
    socketPath,
    authenticationToken: TOKEN,
    requestTimeoutMs: 500,
    shutdownTimeoutMs: 100,
    ...overrides,
  });
  services.add(service);
  return service;
}

afterEach(async () => {
  for (const service of services) {
    try {
      await service.shutdown();
    } catch {
      // Individual tests assert actionable shutdown failures before cleanup.
    }
  }
  services.clear();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
  vi.unstubAllEnvs();
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
});

describe("SCA service startup and Unix-socket framing", () => {
  it("does not bind or listen merely by importing the package entrypoint", async () => {
    const { socketPath } = await temporarySocket();
    vi.stubEnv(SCA_SERVICE_ENV.socketPath, socketPath);
    vi.stubEnv(SCA_SERVICE_ENV.authenticationToken, TOKEN);
    await import("../src/index.js");
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("starts only when called, binds mode 0600, and returns one truthful response", async () => {
    const { socketPath } = await temporarySocket();
    const service = await trackedService(socketPath);
    expect(service.isListening()).toBe(true);
    expect((await lstat(socketPath)).mode & 0o777).toBe(0o600);

    const response = await request(socketPath, `${JSON.stringify(capabilityFrame())}\n`);
    expect(response).toMatchObject({
      protocol: SCA_SERVICE_IPC_PROTOCOL,
      ok: true,
      action: "capability",
      result: {
        status: "unavailable",
        limits: null,
        error: { code: "service_unavailable" },
      },
    });
    await vi.waitFor(() => expect(service.activeConnections()).toBe(0));

    await service.shutdown();
    expect(service.isListening()).toBe(false);
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses malformed JSON and incorrect authentication at the socket boundary", async () => {
    const { socketPath } = await temporarySocket();
    await trackedService(socketPath);

    await expect(request(socketPath, "not-json\n")).resolves.toMatchObject({
      ok: false,
      action: null,
      error: { code: "invalid_request" },
    });
    await expect(
      request(socketPath, `${JSON.stringify(capabilityFrame("incorrect-token"))}\n`)
    ).resolves.toMatchObject({
      ok: false,
      action: null,
      error: { code: "unauthorized" },
    });
  });

  it("refuses two frames and oversized input without processing either as success", async () => {
    const { socketPath } = await temporarySocket();
    await trackedService(socketPath, { maxFrameBytes: 1_024 });
    const encoded = JSON.stringify(capabilityFrame());

    await expect(request(socketPath, `${encoded}\n${encoded}\n`)).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    await expect(request(socketPath, `${"x".repeat(1_025)}\n`)).resolves.toMatchObject({
      ok: false,
      error: { code: "quota_exceeded" },
    });
  });

  it("times out an incomplete frame and closes the connection", async () => {
    const { socketPath } = await temporarySocket();
    const service = await trackedService(socketPath, { requestTimeoutMs: 30 });
    const response = await request(socketPath, "{");
    expect(response).toMatchObject({ ok: false, error: { code: "timeout" } });
    await vi.waitFor(() => expect(service.activeConnections()).toBe(0));
  });

  it("preserves a substitution between the public link and startup verification", async () => {
    const { socketPath } = await temporarySocket();
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let publicLinkCreated = false;
    let substituted = false;
    let foreignIdentity: TestFileIdentity | null = null;

    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      link: async (existingPath: PathLike, newPath: PathLike): Promise<void> => {
        await actualFs.link(existingPath, newPath);
        if (newPath === socketPath) publicLinkCreated = true;
      },
      lstat: async (target: PathLike, options?: StatOptions): Promise<Stats | BigIntStats> => {
        if (publicLinkCreated && !substituted && target === socketPath) {
          substituted = true;
          await actualFs.unlink(socketPath);
          foreignIdentity = await createForeignSocketEntry(socketPath);
        }
        return await actualFs.lstat(target, options);
      },
    }));
    const { startScaService: startWithHostileFs } = await import("../src/server.js");

    await expect(startWithHostileFs({ socketPath, authenticationToken: TOKEN })).rejects.toThrow(
      /does not match the private bound socket/
    );
    expect(substituted).toBe(true);
    expect(await socketIdentity(socketPath)).toEqual(foreignIdentity);
  });

  it("bounds shutdown and preserves a substitution immediately before cleanup", async () => {
    const { socketPath } = await temporarySocket();
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let cleanupArmed = false;
    let substituted = false;
    let foreignIdentity: TestFileIdentity | null = null;

    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      rename: async (oldPath: PathLike, newPath: PathLike): Promise<void> => {
        if (cleanupArmed && !substituted && oldPath === socketPath) {
          substituted = true;
          await actualFs.unlink(socketPath);
          foreignIdentity = await createForeignSocketEntry(socketPath);
        }
        await actualFs.rename(oldPath, newPath);
      },
    }));
    const { startScaService: startWithHostileFs } = await import("../src/server.js");
    const service = await startWithHostileFs({
      socketPath,
      authenticationToken: TOKEN,
      requestTimeoutMs: 5_000,
      shutdownTimeoutMs: 50,
    });
    services.add(service);
    const idleClient = await connect(socketPath);
    cleanupArmed = true;

    const startedAt = Date.now();
    await service.shutdown();
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(substituted).toBe(true);
    expect(await socketIdentity(socketPath)).toEqual(foreignIdentity);
    expect(idleClient.destroyed).toBe(true);
  });

  it("preserves quarantine and a concurrent public entry when restore cannot be proven", async () => {
    const { root, socketPath } = await temporarySocket();
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let cleanupArmed = false;
    let substituted = false;
    let concurrentEntryCreated = false;
    let foreignIdentity: TestFileIdentity | null = null;

    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      rename: async (oldPath: PathLike, newPath: PathLike): Promise<void> => {
        if (cleanupArmed && !substituted && oldPath === socketPath) {
          substituted = true;
          await actualFs.unlink(socketPath);
          foreignIdentity = await createForeignSocketEntry(socketPath);
        }
        await actualFs.rename(oldPath, newPath);
      },
      link: async (existingPath: PathLike, newPath: PathLike): Promise<void> => {
        if (cleanupArmed && substituted && !concurrentEntryCreated && newPath === socketPath) {
          concurrentEntryCreated = true;
          await actualFs.writeFile(socketPath, "concurrent public entry", { mode: 0o600 });
        }
        await actualFs.link(existingPath, newPath);
      },
    }));
    const { startScaService: startWithHostileFs } = await import("../src/server.js");
    const service = await startWithHostileFs({ socketPath, authenticationToken: TOKEN });
    services.add(service);
    cleanupArmed = true;

    await expect(service.shutdown()).rejects.toThrow(/remains preserved at/);
    expect(concurrentEntryCreated).toBe(true);
    expect(await readFile(socketPath, "utf8")).toBe("concurrent public entry");
    const quarantineNames = (await readdir(root)).filter((name) =>
      name.startsWith(".p-sca-quarantine-")
    );
    expect(quarantineNames).toHaveLength(1);
    expect(await socketIdentity(path.join(root, quarantineNames[0]))).toEqual(foreignIdentity);
  });

  it("refuses TCP-shaped config, broad directories, and pre-existing socket paths", async () => {
    const { socketPath } = await temporarySocket();
    expect(() =>
      validateScaServiceConfig({
        socketPath,
        authenticationToken: TOKEN,
        host: "127.0.0.1",
      })
    ).toThrow(/unsupported SCA service config key: host/);

    await expect(
      startScaService({
        socketPath: path.join(tmpdir(), `penny-sca-unsafe-${process.pid}.sock`),
        authenticationToken: TOKEN,
      })
    ).rejects.toThrow(/owned by the service user|mode 0700/);

    await writeFile(socketPath, "do not replace", { mode: 0o600 });
    await expect(startScaService({ socketPath, authenticationToken: TOKEN })).rejects.toThrow(
      /already exists/
    );
    expect(await readFile(socketPath, "utf8")).toBe("do not replace");
  });
});
