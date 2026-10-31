// Test-process only. Install in the isolated fixture-bound qualification child, never in
// normal tests or a production host. Classify process starts as scanner dispatch, TCP
// and fetch as model dispatch, and Unix sockets as application dispatch. The names
// describe P01 counter channels, not a claim about the remote service's identity.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ScaP01DispatchSnapshot } from "../../dist/sca/p01-admission.js";

// The filesystem root is a directory, never an executable or a downstream project.
const SAFE_EXECUTABLE = "/";
const SAFE_PORT = 1;
let installed = false;

export interface P01HostDispatchObserver {
  snapshot(): ScaP01DispatchSnapshot;
  snapshotCount(): number;
  safeUnixPath: string;
  restore(): void;
}

/** A failed real spawnSync of a directory; no shell or application is launched. */
export function attemptSafeChildBoundary(): void {
  const result = childProcess.spawnSync(SAFE_EXECUTABLE, [], { timeout: 1_000, stdio: "ignore" });
  if (result.error === undefined || result.status !== null)
    throw new Error("safe child boundary unexpectedly succeeded");
}

/** A real connect attempt to a refused local TCP port, destroyed without data. */
export function attemptSafeTcpBoundary(): void {
  const socket = net.connect({ host: "127.0.0.1", port: SAFE_PORT });
  socket.on("error", () => {});
  socket.destroy();
}

/** A real connect attempt to a fresh, absent local Unix socket; no data sent. */
export function attemptSafeUnixBoundary(socketPath: string): void {
  const socket = net.connect({ path: socketPath });
  socket.on("error", () => {});
  socket.destroy();
}

/** Only call from the validated, fixture-bound P01 child or its dedicated observer tests. */
export function installP01HostDispatchObserver(): P01HostDispatchObserver {
  if (installed) throw new Error("P01 host dispatch observer already installed");
  const originalSpawnSync = childProcess.spawnSync;
  const originalConnect = net.Socket.prototype.connect;
  const safeUnixPath = path.join(tmpdir(), `penny-p01-observer-${randomUUID()}.sock`);
  const counts = { model: 0, scanner: 0, application: 0 };
  let snapshots = 0;
  let active = true;
  const processBlocked = (): never => {
    counts.scanner++;
    throw new Error("P01 observer blocked non-fixture child dispatch");
  };
  const spawnSyncObserved = (...args: Parameters<typeof childProcess.spawnSync>) => {
    counts.scanner++;
    if (
      args[0] !== SAFE_EXECUTABLE ||
      !Array.isArray(args[1]) ||
      args[1].length !== 0 ||
      args[2]?.timeout !== 1_000 ||
      args[2].stdio !== "ignore"
    )
      throw new Error("P01 observer blocked non-fixture child dispatch");
    return originalSpawnSync(...args);
  };
  const connectObserved = function (this: net.Socket, ...args: Parameters<net.Socket["connect"]>) {
    const first: unknown = args[0];
    // net.connect normalizes options into an array before calling Socket.connect.
    const target: unknown = Array.isArray(first) ? first[0] : first;
    if (typeof target === "object" && target !== null && "path" in target) {
      counts.application++;
      if (target.path !== safeUnixPath) throw new Error("P01 observer blocked Unix dispatch");
    } else {
      counts.model++;
      if (
        typeof target !== "object" ||
        target === null ||
        !("host" in target) ||
        target.host !== "127.0.0.1" ||
        !("port" in target) ||
        target.port !== SAFE_PORT
      )
        throw new Error("P01 observer blocked TCP dispatch");
    }
    const socket: unknown = Reflect.apply(originalConnect, this, args);
    if (!(socket instanceof net.Socket)) throw new Error("P01 observer lost socket boundary");
    return socket;
  };
  const fetchObserved = async (): Promise<Response> => {
    counts.model++;
    throw new Error("P01 observer blocked fetch dispatch");
  };
  // Save every descriptor. A failed installation rolls back every patched surface.
  const patches: { object: object; key: string; descriptor: PropertyDescriptor; value: unknown }[] =
    [];
  const patch = (object: object, key: string, value: unknown): void => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined || !descriptor.configurable)
      throw new Error(`P01 observer cannot patch ${key}`);
    Object.defineProperty(object, key, { ...descriptor, value });
    patches.push({ object, key, descriptor, value });
  };
  const rollback = (): boolean => {
    let replaced = false;
    for (const item of patches.reverse()) {
      if (!Object.is(Object.getOwnPropertyDescriptor(item.object, item.key)?.value, item.value)) {
        replaced = true;
        continue; // Never overwrite a foreign patch; restore every surface still ours.
      }
      Object.defineProperty(item.object, item.key, item.descriptor);
    }
    syncBuiltinESMExports();
    installed = replaced; // A foreign patch requires process isolation, not a new install.
    active = false;
    return replaced;
  };
  installed = true;
  try {
    patch(childProcess, "spawn", processBlocked);
    patch(childProcess, "spawnSync", spawnSyncObserved);
    patch(childProcess, "exec", processBlocked);
    patch(childProcess, "execSync", processBlocked);
    patch(childProcess, "execFile", processBlocked);
    patch(childProcess, "execFileSync", processBlocked);
    patch(childProcess, "fork", processBlocked);
    patch(net.Socket.prototype, "connect", connectObserved);
    patch(globalThis, "fetch", fetchObserved);
    syncBuiltinESMExports();
  } catch (error) {
    rollback();
    throw error;
  }
  return {
    safeUnixPath,
    snapshot: () => {
      if (!active) throw new Error("P01 observer was restored");
      snapshots++;
      return { ...counts };
    },
    snapshotCount: () => snapshots,
    restore: () => {
      if (!active) throw new Error("P01 observer was already restored");
      if (rollback()) throw new Error("P01 observer patch was replaced; foreign patch preserved");
    },
  };
}
