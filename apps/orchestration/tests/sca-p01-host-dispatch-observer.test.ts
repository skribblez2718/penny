import childProcess, { spawn as namedSpawn } from "node:child_process";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  installP01HostDispatchObserver,
  attemptSafeChildBoundary,
  attemptSafeTcpBoundary,
  attemptSafeUnixBoundary,
  type P01HostDispatchObserver,
} from "./fixtures/p01-host-dispatch-observer.js";

let observer: P01HostDispatchObserver | undefined;
afterEach(() => {
  observer?.restore();
  observer = undefined;
});

describe("isolated test-process P01 host dispatch observer", () => {
  it("observes actual child, TCP, and Unix boundaries and restores the host", () => {
    const originalSpawn = childProcess.spawnSync;
    const originalNamedSpawn = namedSpawn;
    const originalConnect = net.Socket.prototype.connect;
    const originalFetch = globalThis.fetch;
    observer = installP01HostDispatchObserver();
    const before = observer.snapshot();
    attemptSafeChildBoundary();
    attemptSafeTcpBoundary();
    attemptSafeUnixBoundary(observer.safeUnixPath);
    const after = observer.snapshot();
    expect(after).toEqual({
      model: before.model + 1,
      scanner: before.scanner + 1,
      application: before.application + 1,
    });
    expect(() => installP01HostDispatchObserver()).toThrow("already installed");
    observer.restore();
    observer = undefined;
    expect(childProcess.spawnSync).toBe(originalSpawn);
    expect(namedSpawn).toBe(originalNamedSpawn);
    expect(net.Socket.prototype.connect).toBe(originalConnect);
    expect(globalThis.fetch).toBe(originalFetch);
    expect(() => attemptSafeChildBoundary()).not.toThrow();
  });

  it("blocks malformed/non-fixture destinations, observes them, and refuses stale snapshots", async () => {
    observer = installP01HostDispatchObserver();
    const before = observer.snapshot();
    expect(() => childProcess.spawnSync("not-the-safe-executable")).toThrow("blocked");
    expect(namedSpawn).toBe(childProcess.spawn);
    expect(() => namedSpawn("not-the-safe-executable")).toThrow("blocked");
    expect(() => net.connect({ host: "example.invalid", port: 443 })).toThrow("blocked TCP");
    expect(() => net.connect({ path: "/not-the-safe-socket" })).toThrow("blocked Unix");
    await expect(fetch("http://127.0.0.1:1/")).rejects.toThrow("blocked fetch");
    expect(observer.snapshot()).toEqual({
      model: before.model + 2,
      scanner: before.scanner + 2,
      application: before.application + 1,
    });
    const prior = observer;
    observer.restore();
    observer = undefined;
    expect(() => prior.snapshot()).toThrow("restored");
    expect(() => prior.restore()).toThrow("already restored");
    observer = installP01HostDispatchObserver();
    expect(observer.snapshot()).toEqual({ model: 0, scanner: 0, application: 0 });
  });
});
