import { randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { chmod, link, lstat, realpath, rename, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";

import { validateScaServiceConfig, type ScaServiceConfigInput } from "./config.js";
import {
  createScaRouter,
  createScaServiceErrorResponse,
  type ScaServiceResponseV1,
} from "./router.js";

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly owner: bigint;
}

const QUARANTINE_NAME_ATTEMPTS = 8;

export interface ScaServiceHandle {
  readonly socketPath: string;
  isListening(): boolean;
  activeConnections(): number;
  lastServerError(): Error | null;
  shutdown(): Promise<void>;
}

function currentUserId(): bigint {
  const getuid = process.getuid;
  if (getuid === undefined) throw new Error("the SCA service requires a POSIX user identity");
  return BigInt(getuid());
}

function identityOf(stats: {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly uid: number | bigint;
}): FileIdentity {
  return {
    device: BigInt(stats.dev),
    inode: BigInt(stats.ino),
    owner: BigInt(stats.uid),
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.owner === right.owner;
}

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function assertPrivateSocketDirectory(directory: string): Promise<FileIdentity> {
  const stats = await lstat(directory, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("socketPath parent must be a real directory");
  }
  if (stats.uid !== currentUserId()) {
    throw new Error("socketPath parent must be owned by the service user");
  }
  if ((stats.mode & 0o777n) !== 0o700n) {
    throw new Error("socketPath parent must have mode 0700");
  }
  if ((await realpath(directory)) !== directory) {
    throw new Error("socketPath parent may not traverse symbolic links");
  }
  return identityOf(stats);
}

async function assertPathAbsent(target: string): Promise<void> {
  if ((await lstatOrNull(target)) !== null) {
    throw new Error("socketPath already exists; refusing to unlink an untrusted entry");
  }
}

function cleanupError(message: string, cause?: unknown): Error {
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

async function restoreForeignQuarantine(
  target: string,
  quarantinePath: string,
  foreignIdentity: FileIdentity
): Promise<void> {
  try {
    // link(2) is an atomic no-clobber restore: it fails rather than replacing a
    // concurrently created public entry.
    await link(quarantinePath, target);
  } catch (error) {
    throw cleanupError(
      `socket cleanup could not restore a foreign entry; it remains preserved at ${quarantinePath}`,
      error
    );
  }

  try {
    const [quarantined, restored] = await Promise.all([
      lstat(quarantinePath, { bigint: true }),
      lstat(target, { bigint: true }),
    ]);
    if (
      !sameIdentity(identityOf(quarantined), foreignIdentity) ||
      !sameIdentity(identityOf(restored), foreignIdentity)
    ) {
      throw new Error("restored path identity does not match the quarantined entry");
    }
  } catch (error) {
    throw cleanupError(
      `socket cleanup could not prove restoration of a foreign entry; it remains preserved at ${quarantinePath}`,
      error
    );
  }

  try {
    await unlink(quarantinePath);
  } catch (error) {
    throw cleanupError(
      `socket cleanup restored a foreign entry but could not remove its quarantine link at ${quarantinePath}`,
      error
    );
  }
}

async function unusedQuarantinePath(directory: string): Promise<string> {
  for (let attempt = 0; attempt < QUARANTINE_NAME_ATTEMPTS; attempt += 1) {
    const candidate = path.join(directory, `.p-sca-quarantine-${randomBytes(16).toString("hex")}`);
    if ((await lstatOrNull(candidate)) === null) return candidate;
  }
  throw new Error("socket cleanup could not allocate an unused quarantine name");
}

async function removeOwnedSocket(
  target: string,
  expected: FileIdentity,
  expectedParent: FileIdentity
): Promise<boolean> {
  const directory = path.dirname(target);
  const currentParent = await assertPrivateSocketDirectory(directory);
  if (!sameIdentity(currentParent, expectedParent)) {
    throw new Error("socket cleanup refused a changed socketPath parent");
  }
  const quarantinePath = await unusedQuarantinePath(directory);

  try {
    // Moving first closes the public-path lstat -> unlink race. Any later unlink
    // is confined to an unpredictable name inside the owner-only directory.
    await rename(target, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  let quarantined: BigIntStats;
  try {
    quarantined = await lstat(quarantinePath, { bigint: true });
  } catch (error) {
    throw cleanupError(
      `socket cleanup could not inspect the quarantined entry at ${quarantinePath}`,
      error
    );
  }

  const quarantinedIdentity = identityOf(quarantined);
  if (quarantined.isSocket() && sameIdentity(quarantinedIdentity, expected)) {
    await unlink(quarantinePath);
    return true;
  }

  await restoreForeignQuarantine(target, quarantinePath, quarantinedIdentity);
  return false;
}

function waitFor<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function closeServerBoundedly(
  server: Server,
  sockets: ReadonlySet<Socket>,
  timeoutMs: number
): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  if ((await waitFor(closed, timeoutMs)) !== null) return;
  for (const socket of sockets) socket.destroy();
  if ((await waitFor(closed, Math.min(timeoutMs, 250))) === null) {
    throw new Error("SCA service shutdown exceeded its bounded grace period");
  }
}

function serializeResponse(response: ScaServiceResponseV1, maxFrameBytes: number): string | null {
  const encoded = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(encoded) <= maxFrameBytes) return encoded;
  const fallback = `${JSON.stringify(
    createScaServiceErrorResponse(
      response.action,
      "output_truncated",
      "response exceeds the IPC frame limit"
    )
  )}\n`;
  return Buffer.byteLength(fallback) <= maxFrameBytes ? fallback : null;
}

function attachConnectionHandler(
  server: Server,
  sockets: Set<Socket>,
  config: ReturnType<typeof validateScaServiceConfig>
): void {
  const router = createScaRouter({ authenticationToken: config.authenticationToken });
  server.on("connection", (socket) => {
    sockets.add(socket);
    let buffered = Buffer.alloc(0);
    let frameStarted = false;
    let responseStarted = false;
    let requestTimer: NodeJS.Timeout | null = null;

    const respond = (response: ScaServiceResponseV1): void => {
      if (responseStarted || socket.destroyed) return;
      responseStarted = true;
      if (requestTimer !== null) clearTimeout(requestTimer);
      socket.pause();
      const encoded = serializeResponse(response, config.maxFrameBytes);
      if (encoded === null) socket.destroy();
      else socket.end(encoded, "utf8");
    };

    const processFrame = async (bytes: Buffer): Promise<void> => {
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        respond(
          createScaServiceErrorResponse(null, "invalid_request", "request is not valid JSON")
        );
        return;
      }
      try {
        respond(await router.route(value));
      } catch {
        respond(createScaServiceErrorResponse(null, "failed", "request processing failed"));
      }
    };

    requestTimer = setTimeout(() => {
      respond(createScaServiceErrorResponse(null, "timeout", "request timed out"));
    }, config.requestTimeoutMs);
    requestTimer.unref();
    socket.on("data", (chunk: Buffer) => {
      if (frameStarted || responseStarted) return;
      const newline = chunk.indexOf(0x0a);
      if (newline === -1) {
        if (buffered.length + chunk.length > config.maxFrameBytes) {
          respond(
            createScaServiceErrorResponse(
              null,
              "quota_exceeded",
              "request exceeds the IPC frame limit"
            )
          );
          return;
        }
        buffered = Buffer.concat([buffered, chunk], buffered.length + chunk.length);
        return;
      }
      const frameLength = buffered.length + newline;
      if (frameLength > config.maxFrameBytes) {
        respond(
          createScaServiceErrorResponse(
            null,
            "quota_exceeded",
            "request exceeds the IPC frame limit"
          )
        );
        return;
      }
      if (newline + 1 !== chunk.length) {
        respond(
          createScaServiceErrorResponse(
            null,
            "invalid_request",
            "only one newline-delimited frame is allowed"
          )
        );
        return;
      }
      frameStarted = true;
      socket.pause();
      const frame = Buffer.concat([buffered, chunk.subarray(0, newline)], frameLength);
      buffered = Buffer.alloc(0);
      void processFrame(frame);
    });
    socket.on("end", () => {
      if (!frameStarted && !responseStarted) {
        respond(
          createScaServiceErrorResponse(
            null,
            "invalid_request",
            "request ended before a newline-delimited frame was received"
          )
        );
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (requestTimer !== null) clearTimeout(requestTimer);
      sockets.delete(socket);
    });
  });
}

export async function startScaService(input: ScaServiceConfigInput): Promise<ScaServiceHandle> {
  const config = validateScaServiceConfig(input);
  const directory = path.dirname(config.socketPath);
  const parentIdentity = await assertPrivateSocketDirectory(directory);
  await assertPathAbsent(config.socketPath);

  const internalSocketPath = path.join(directory, `.p-sca-${randomBytes(12).toString("hex")}`);
  await assertPathAbsent(internalSocketPath);

  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true });
  server.maxConnections = config.maxConnections;
  attachConnectionHandler(server, sockets, config);

  let runtimeError: Error | null = null;
  let publicIdentity: FileIdentity | null = null;
  const rememberRuntimeError = (error: Error): void => {
    runtimeError = error;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(internalSocketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });
    server.on("error", rememberRuntimeError);

    const internalBeforeChmod = await lstat(internalSocketPath, { bigint: true });
    if (!internalBeforeChmod.isSocket() || internalBeforeChmod.uid !== currentUserId()) {
      throw new Error("private bound socket has an unexpected identity");
    }
    await chmod(internalSocketPath, 0o600);
    const internal = await lstat(internalSocketPath, { bigint: true });
    if (
      !internal.isSocket() ||
      internal.uid !== currentUserId() ||
      (internal.mode & 0o777n) !== 0o600n
    ) {
      throw new Error("private bound socket must be owner-only mode 0600");
    }
    const internalIdentity = identityOf(internal);
    if (!sameIdentity(identityOf(internalBeforeChmod), internalIdentity)) {
      throw new Error("private bound socket identity changed during setup");
    }
    const currentParent = await assertPrivateSocketDirectory(directory);
    if (!sameIdentity(currentParent, parentIdentity)) {
      throw new Error("socketPath parent identity changed during setup");
    }

    // The server owns the random private path. The configured path is a hard link to the
    // same socket inode, so Node can never auto-unlink an attacker-substituted public path.
    await link(internalSocketPath, config.socketPath);
    const publicSocket = await lstat(config.socketPath, { bigint: true });
    if (
      !publicSocket.isSocket() ||
      (publicSocket.mode & 0o777n) !== 0o600n ||
      !sameIdentity(identityOf(publicSocket), internalIdentity)
    ) {
      throw new Error("public socket path does not match the private bound socket");
    }
    publicIdentity = internalIdentity;
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      try {
        await closeServerBoundedly(server, sockets, config.shutdownTimeoutMs);
      } catch {
        // Preserve the setup failure as the actionable error.
      }
    }
    if (publicIdentity !== null) {
      try {
        await removeOwnedSocket(config.socketPath, publicIdentity, parentIdentity);
      } catch {
        // Preserve the setup failure as the actionable error.
      }
    }
    throw error;
  }

  let shutdownPromise: Promise<void> | null = null;
  return Object.freeze({
    socketPath: config.socketPath,
    isListening: () => server.listening,
    activeConnections: () => sockets.size,
    lastServerError: () => runtimeError,
    shutdown(): Promise<void> {
      if (shutdownPromise !== null) return shutdownPromise;
      shutdownPromise = (async () => {
        let cleanupError: unknown;
        try {
          if (publicIdentity !== null) {
            await removeOwnedSocket(config.socketPath, publicIdentity, parentIdentity);
          }
        } catch (error) {
          cleanupError = error;
        }
        await closeServerBoundedly(server, sockets, config.shutdownTimeoutMs);
        server.off("error", rememberRuntimeError);
        if (cleanupError !== undefined) throw cleanupError;
      })();
      return shutdownPromise;
    },
  });
}
