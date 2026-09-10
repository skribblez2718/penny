import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BrowserManager, BrowserPolicyViolationError } from "../../browser.js";
import type { PlaywrightConfig } from "../../types.js";
import { runWithAdmittedRegisteredBrowserPolicy } from "../helpers/registered-browser-policy.js";

const browserTestsEnabled = process.env.PENNY_PLAYWRIGHT_BROWSER_TESTS === "1";
const browserDescribe = browserTestsEnabled ? describe : describe.skip;
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7B8AAAAASUVORK5CYII=",
  "base64"
);
const SLOW_NAVIGATION_DELAY_MS = 250;

interface LoopbackSink {
  readonly origin: string;
  readonly counts: Map<string, number>;
  readonly server: Server;
}

function increment(counts: Map<string, number>, path: string): void {
  counts.set(path, (counts.get(path) ?? 0) + 1);
}

function handleRequest(
  counts: Map<string, number>,
  request: IncomingMessage,
  response: ServerResponse
): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  increment(counts, url.pathname);
  response.setHeader("Access-Control-Allow-Origin", "*");

  if (url.pathname.endsWith(".png")) {
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(ONE_PIXEL_PNG);
    return;
  }
  if (url.pathname.startsWith("/redirect")) {
    response.writeHead(302, { Location: url.searchParams.get("to") ?? "/" });
    response.end();
    return;
  }
  if (url.pathname === "/worker.js") {
    response.writeHead(200, { "Content-Type": "application/javascript" });
    response.end(
      "self.onmessage = (event) => { if (event.data === 'probe-guards') { self.postMessage({ webTransport: typeof self.WebTransport, nestedWorker: typeof self.Worker, sharedWorker: typeof self.SharedWorker }); return; } fetch(event.data).then(() => self.postMessage('ok')).catch(() => self.postMessage('denied')); };"
    );
    return;
  }
  if (url.pathname === "/service-worker.js") {
    response.writeHead(200, { "Content-Type": "application/javascript" });
    response.end("self.addEventListener('fetch', () => {});");
    return;
  }
  if (url.pathname === "/event-stream") {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end("data: event\n\n");
    return;
  }
  if (url.pathname === "/download") {
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment; filename=test.bin",
    });
    response.end("download");
    return;
  }
  if (url.pathname === "/slow-navigation") {
    response.writeHead(200, { "Content-Type": "text/html" });
    setTimeout(() => {
      response.end("<!doctype html><title>slow navigation</title><body>complete</body>");
    }, SLOW_NAVIGATION_DELAY_MS).unref();
    return;
  }

  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(`<!doctype html><title>${url.pathname}</title><body>${url.pathname}</body>`);
}

function handleUpgrade(
  counts: Map<string, number>,
  request: IncomingMessage,
  socket: Duplex
): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  increment(counts, url.pathname);
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  setTimeout(() => socket.end(), 100).unref();
}

async function startLoopbackSink(): Promise<LoopbackSink> {
  const counts = new Map<string, number>();
  const server = createServer((request, response) => handleRequest(counts, request, response));
  server.on("upgrade", (request, socket) => handleUpgrade(counts, request, socket));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("loopback sink did not receive a TCP address");
  }
  return { origin: `http://127.0.0.1:${address.port}`, counts, server };
}

async function closeSink(sink: LoopbackSink): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sink.server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function waitForRequest(sink: LoopbackSink, path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while ((sink.counts.get(path) ?? 0) < 1) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for loopback request ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function ownedProcessExited(browserProcess: ChildProcess): boolean {
  return browserProcess.exitCode !== null || browserProcess.signalCode !== null;
}

function testConfig(networkAllowlist: readonly string[] = []): PlaywrightConfig {
  return {
    headless: true,
    timeout: 5_000,
    networkAllowlist,
    downloadDir: "/tmp",
    outputDir: "/tmp",
    enableVision: false,
    enableDevtools: false,
    enableNetwork: false,
    enableStorage: false,
    allowUnsafe: false,
    ignoreHTTPSErrors: false,
  };
}

let allowedSink: LoopbackSink;
let forbiddenSink: LoopbackSink;
let manager: BrowserManager;

beforeAll(async () => {
  if (!browserTestsEnabled) return;
  allowedSink = await startLoopbackSink();
  forbiddenSink = await startLoopbackSink();
  manager = BrowserManager.getBrowser(testConfig());
});

beforeEach(() => {
  if (!browserTestsEnabled) return;
  allowedSink.counts.clear();
  forbiddenSink.counts.clear();
});

afterAll(async () => {
  if (!browserTestsEnabled) return;
  await manager.cleanup();
  await Promise.all([closeSink(allowedSink), closeSink(forbiddenSink)]);
  await BrowserManager.resetForTesting();
});

browserDescribe("production BrowserManager network boundary", () => {
  it("single-flights concurrent same-scope browser launch and exits its one owned process", async () => {
    const ownedProcesses: ChildProcess[] = [];
    const concurrentManager = BrowserManager.createForTesting(testConfig(), {
      onBrowserProcessOwned(browserProcess) {
        ownedProcesses.push(browserProcess);
      },
    });

    try {
      await Promise.all(Array.from({ length: 8 }, async () => concurrentManager.ensureBrowser()));
      expect(ownedProcesses).toHaveLength(1);
      expect(new Set(ownedProcesses).size).toBe(1);
      expect(concurrentManager.hasOwnedLiveBrowserProcess()).toBe(true);
    } finally {
      await concurrentManager.cleanup();
    }

    expect(ownedProcesses).toHaveLength(1);
    expect(ownedProcesses.every(ownedProcessExited)).toBe(true);
    expect(concurrentManager.isAnyScopeConnected()).toBe(false);
    expect(concurrentManager.hasOwnedLiveBrowserProcess()).toBe(false);
  }, 20_000);

  it("cancels an in-flight same-scope launch before cleanup retires its owned process", async () => {
    const ownedProcesses: ChildProcess[] = [];
    let cleanup: Promise<void> | undefined;
    const launchManager = BrowserManager.createForTesting(testConfig(), {
      onBrowserProcessOwned(browserProcess) {
        ownedProcesses.push(browserProcess);
        cleanup = launchManager.cleanupCurrentScope();
      },
    });

    await expect(launchManager.ensureBrowser()).rejects.toMatchObject({
      code: "BROWSER_POLICY_SCOPE_RETIRING",
    });
    if (cleanup === undefined) throw new Error("Launch cleanup was not started");
    await cleanup;

    expect(ownedProcesses).toHaveLength(1);
    expect(ownedProcesses.every(ownedProcessExited)).toBe(true);
    expect(launchManager.isAnyScopeConnected()).toBe(false);
    expect(launchManager.hasOwnedLiveBrowserProcess()).toBe(false);
  }, 20_000);

  it("lets an in-flight navigation finish before same-scope cleanup retires every resource", async () => {
    const ownedProcesses: ChildProcess[] = [];
    const racingManager = BrowserManager.createForTesting(testConfig(), {
      onBrowserProcessOwned(browserProcess) {
        ownedProcesses.push(browserProcess);
      },
    });

    try {
      await runWithAdmittedRegisteredBrowserPolicy(
        {
          ownerScopeId: "navigation-cleanup-owner",
          invocationId: "navigation-cleanup-invocation",
          rawAllowlist: [new URL(allowedSink.origin).host],
        },
        async () => {
          const navigation = racingManager.navigate(`${allowedSink.origin}/slow-navigation`);
          await waitForRequest(allowedSink, "/slow-navigation");
          const cleanup = racingManager.cleanupCurrentScope();
          const [result] = await Promise.all([navigation, cleanup]);
          expect(result).toMatchObject({ status: 200, title: "slow navigation" });
        }
      );
    } finally {
      await racingManager.cleanup();
    }

    expect(ownedProcesses).toHaveLength(1);
    expect(ownedProcesses.every(ownedProcessExited)).toBe(true);
    expect(racingManager.isAnyScopeConnected()).toBe(false);
    expect(racingManager.hasOwnedLiveBrowserProcess()).toBe(false);
  }, 20_000);

  it("permits allowed traffic and gives forbidden sinks zero requests across browser channels", async () => {
    const allowedAuthority = new URL(allowedSink.origin).host;

    await runWithAdmittedRegisteredBrowserPolicy(
      {
        ownerScopeId: "browser-owner",
        invocationId: "coverage-invocation",
        rawAllowlist: [allowedAuthority],
      },
      async () => {
        const navigation = await manager.navigate(`${allowedSink.origin}/allowed-navigation`);
        expect(navigation.status).toBe(200);
        expect(allowedSink.counts.get("/allowed-navigation")).toBe(1);
        for (const operation of [
          "page-request-routing",
          "proxy-mutation",
          "proxy-reachability-check",
          "unsafe-code",
          "raw-browser-access",
        ] as const) {
          expect(() => manager.assertOperationAllowed(operation)).toThrowError(
            BrowserPolicyViolationError
          );
        }

        await expect(
          manager.navigate(`${forbiddenSink.origin}/direct-navigation`)
        ).rejects.toBeInstanceOf(BrowserPolicyViolationError);

        const page = await manager.getPage();
        const runtimeGuards = await page.evaluate(`({
          rtc: typeof globalThis.RTCPeerConnection,
          webkitRtc: typeof globalThis.webkitRTCPeerConnection,
          webTransport: typeof globalThis.WebTransport,
          worker: typeof globalThis.Worker,
          sharedWorker: typeof globalThis.SharedWorker
        })`);
        expect(runtimeGuards).toEqual({
          rtc: "undefined",
          webkitRtc: "undefined",
          webTransport: "undefined",
          worker: "undefined",
          sharedWorker: "undefined",
        });
        const unsupportedWorkersBlocked = await page.evaluate(
          ({ allowedOrigin, forbiddenOrigin }) => {
            let classicWorkerBlocked = false;
            let moduleWorkerBlocked = false;
            let blobWorkerBlocked = false;
            try {
              new Worker(`${forbiddenOrigin}/worker-should-not-load`);
            } catch {
              classicWorkerBlocked = true;
            }
            try {
              new Worker(`${allowedOrigin}/module-worker-should-not-load`, { type: "module" });
            } catch {
              moduleWorkerBlocked = true;
            }
            try {
              new Worker(URL.createObjectURL(new Blob(["postMessage('bypass')"])));
            } catch {
              blobWorkerBlocked = true;
            }
            return { classicWorkerBlocked, moduleWorkerBlocked, blobWorkerBlocked };
          },
          { allowedOrigin: allowedSink.origin, forbiddenOrigin: forbiddenSink.origin }
        );
        expect(unsupportedWorkersBlocked).toEqual({
          classicWorkerBlocked: true,
          moduleWorkerBlocked: true,
          blobWorkerBlocked: true,
        });
        expect(allowedSink.counts.get("/module-worker-should-not-load") ?? 0).toBe(0);

        const allowedWebSocketOpened = await page.evaluate(
          async ({ allowedOrigin, forbiddenOrigin }) => {
            fetch(`${allowedOrigin}/allowed-fetch`).catch(() => {});
            fetch(`${forbiddenOrigin}/fetch`).catch(() => {});

            const xhr = new XMLHttpRequest();
            xhr.open("GET", `${forbiddenOrigin}/xhr`);
            xhr.send();

            navigator.sendBeacon(`${forbiddenOrigin}/beacon`, "private-payload");
            const events = new EventSource(`${forbiddenOrigin}/event-stream`);
            events.onerror = () => events.close();

            const allowedImage = document.createElement("img");
            allowedImage.src = `${allowedOrigin}/allowed-image.png`;
            document.body.append(allowedImage);
            const forbiddenImage = document.createElement("img");
            forbiddenImage.src = `${forbiddenOrigin}/subresource.png`;
            document.body.append(forbiddenImage);
            const redirectedImage = document.createElement("img");
            redirectedImage.src = `${allowedOrigin}/redirect-image?to=${encodeURIComponent(`${forbiddenOrigin}/redirect-image-target`)}`;
            document.body.append(redirectedImage);

            const allowedFrame = document.createElement("iframe");
            allowedFrame.src = `${allowedOrigin}/allowed-frame`;
            document.body.append(allowedFrame);
            const forbiddenFrame = document.createElement("iframe");
            forbiddenFrame.src = `${forbiddenOrigin}/frame`;
            document.body.append(forbiddenFrame);
            const redirectedFrame = document.createElement("iframe");
            redirectedFrame.src = `${allowedOrigin}/redirect-frame?to=${encodeURIComponent(`${forbiddenOrigin}/redirect-frame-target`)}`;
            document.body.append(redirectedFrame);

            const popup = window.open(`${forbiddenOrigin}/popup`, "_blank");
            const redirectedPopup = window.open(
              `${allowedOrigin}/redirect-popup?to=${encodeURIComponent(`${forbiddenOrigin}/redirect-popup-target`)}`,
              "_blank"
            );
            setTimeout(() => {
              popup?.close();
              redirectedPopup?.close();
            }, 500);

            const allowedSocket = new WebSocket(
              allowedOrigin.replace("http:", "ws:") + "/allowed-ws"
            );
            const socketOpened = new Promise<boolean>((resolve) => {
              const timer = setTimeout(() => resolve(false), 1_000);
              allowedSocket.onopen = () => {
                clearTimeout(timer);
                resolve(true);
              };
              allowedSocket.onerror = () => {
                clearTimeout(timer);
                resolve(false);
                allowedSocket.close();
              };
            });
            const forbiddenSocket = new WebSocket(
              forbiddenOrigin.replace("http:", "ws:") + "/websocket"
            );
            forbiddenSocket.onerror = () => forbiddenSocket.close();

            if ("serviceWorker" in navigator) {
              navigator.serviceWorker
                .register(`${allowedOrigin}/service-worker.js`)
                .catch(() => {});
            }
            return socketOpened;
          },
          { allowedOrigin: allowedSink.origin, forbiddenOrigin: forbiddenSink.origin }
        );

        expect(allowedWebSocketOpened).toBe(true);
        await page.waitForTimeout(1_000);
        expect(allowedSink.counts.get("/allowed-fetch")).toBe(1);
        expect(allowedSink.counts.get("/allowed-image.png")).toBe(1);
        expect(allowedSink.counts.get("/allowed-frame")).toBe(1);
        expect(allowedSink.counts.get("/worker.js") ?? 0).toBe(0);
        expect(allowedSink.counts.get("/allowed-worker-fetch") ?? 0).toBe(0);
        expect(allowedSink.counts.get("/allowed-ws")).toBe(1);
        expect(allowedSink.counts.get("/redirect-image")).toBe(1);
        expect(allowedSink.counts.get("/redirect-frame")).toBe(1);
        expect(allowedSink.counts.get("/redirect-popup")).toBe(1);
        expect(allowedSink.counts.get("/redirect-worker-fetch") ?? 0).toBe(0);
        expect(allowedSink.counts.get("/redirect-worker-script") ?? 0).toBe(0);
        expect(allowedSink.counts.get("/service-worker.js") ?? 0).toBe(0);

        const downloadEvent = page.waitForEvent("download", { timeout: 1_000 });
        await page.evaluate((allowedOrigin) => {
          const link = document.createElement("a");
          link.href = `${allowedOrigin}/download`;
          link.download = "test.bin";
          document.body.append(link);
          link.click();
        }, allowedSink.origin);
        const download = await downloadEvent;
        expect(await download.failure()).toMatch(/acceptDownloads/);
        expect(allowedSink.counts.get("/download")).toBe(1);

        const allowedRedirect = await manager.navigate(
          `${allowedSink.origin}/redirect-allowed?to=${encodeURIComponent(`${allowedSink.origin}/allowed-redirect-target`)}`
        );
        expect(allowedRedirect.status).toBe(200);
        expect(allowedSink.counts.get("/redirect-allowed")).toBe(1);
        expect(allowedSink.counts.get("/allowed-redirect-target")).toBe(1);

        await expect(
          manager.navigate(
            `${allowedSink.origin}/redirect?to=${encodeURIComponent(`${forbiddenSink.origin}/redirect-target`)}`
          )
        ).rejects.toBeInstanceOf(BrowserPolicyViolationError);
        expect(allowedSink.counts.get("/redirect")).toBe(1);
        expect([...forbiddenSink.counts.values()].reduce((sum, count) => sum + count, 0)).toBe(0);
      }
    );
  });

  it("activates the registration carrier in BrowserManager and preserves ordinary behavior", async () => {
    const registeredAllowlist = [new URL(allowedSink.origin).host];

    await runWithAdmittedRegisteredBrowserPolicy(
      {
        ownerScopeId: "registered-browser-owner",
        invocationId: "registered-browser-invocation",
        registrationName: "synthetic-browser-registration",
        stateId: "browser-phase",
        rawAllowlist: registeredAllowlist,
      },
      async () => {
        expect(manager.getPolicyStatus()).toMatchObject({
          mode: "allow",
          invocationPolicyPresent: true,
        });
        expect((await manager.navigate(`${allowedSink.origin}/registered-allowed`)).status).toBe(
          200
        );
        await expect(
          manager.navigate(`${forbiddenSink.origin}/registered-forbidden`)
        ).rejects.toBeInstanceOf(BrowserPolicyViolationError);
      }
    );

    expect(allowedSink.counts.get("/registered-allowed")).toBe(1);
    expect(forbiddenSink.counts.get("/registered-forbidden") ?? 0).toBe(0);

    expect(manager.getPolicyStatus()).toMatchObject({
      mode: "unrestricted",
      invocationPolicyPresent: false,
    });
    expect((await manager.navigate(`${allowedSink.origin}/ordinary-allowed`)).status).toBe(200);
    expect((await manager.navigate(`${forbiddenSink.origin}/ordinary-forbidden`)).status).toBe(200);
    expect(allowedSink.counts.get("/ordinary-allowed")).toBe(1);
    expect(forbiddenSink.counts.get("/ordinary-forbidden")).toBe(1);

    await manager.cleanupOrdinaryScopes();
    await runWithAdmittedRegisteredBrowserPolicy(
      {
        ownerScopeId: "registered-browser-owner",
        invocationId: "registered-browser-invocation",
        registrationName: "synthetic-browser-registration",
        stateId: "browser-phase",
        rawAllowlist: registeredAllowlist,
      },
      async () => {
        expect(
          (await manager.navigate(`${allowedSink.origin}/registered-after-ordinary-cleanup`)).status
        ).toBe(200);
      }
    );
    expect(allowedSink.counts.get("/registered-after-ordinary-cleanup")).toBe(1);
  });

  it("isolates interleaved registration-owned scopes", async () => {
    const firstAllowlist = [new URL(allowedSink.origin).host];
    const secondAllowlist = [new URL(forbiddenSink.origin).host];

    const [firstTabs, secondTabs] = await Promise.all([
      runWithAdmittedRegisteredBrowserPolicy(
        {
          ownerScopeId: "parallel-owner-a",
          invocationId: "parallel-a",
          registrationName: "synthetic-browser-registration",
          stateId: "browser-phase",
          rawAllowlist: firstAllowlist,
        },
        async () => {
          await manager.navigate(`${allowedSink.origin}/scope-a`);
          await new Promise((resolve) => setTimeout(resolve, 25));
          await expect(
            manager.navigate(`${forbiddenSink.origin}/scope-a-denied`)
          ).rejects.toBeInstanceOf(BrowserPolicyViolationError);
          return manager.listTabs();
        }
      ),
      runWithAdmittedRegisteredBrowserPolicy(
        {
          ownerScopeId: "parallel-owner-b",
          invocationId: "parallel-b",
          registrationName: "synthetic-browser-registration",
          stateId: "browser-phase",
          rawAllowlist: secondAllowlist,
        },
        async () => {
          await manager.navigate(`${forbiddenSink.origin}/scope-b`);
          await new Promise((resolve) => setTimeout(resolve, 1));
          await expect(
            manager.navigate(`${allowedSink.origin}/scope-b-denied`)
          ).rejects.toBeInstanceOf(BrowserPolicyViolationError);
          return manager.listTabs();
        }
      ),
    ]);

    expect(firstTabs.tabs.every((tab) => tab.url.startsWith(allowedSink.origin))).toBe(true);
    expect(secondTabs.tabs.every((tab) => tab.url.startsWith(forbiddenSink.origin))).toBe(true);
    expect(allowedSink.counts.get("/scope-b-denied") ?? 0).toBe(0);
    expect(forbiddenSink.counts.get("/scope-a-denied") ?? 0).toBe(0);
  });

  it("composes the immutable process ceiling by intersection and never widens it", async () => {
    const ceilingManager = BrowserManager.createForTesting(
      testConfig([new URL(allowedSink.origin).host])
    );
    try {
      await runWithAdmittedRegisteredBrowserPolicy(
        {
          ownerScopeId: "ceiling-owner",
          invocationId: "ceiling-compatible",
          registrationName: "synthetic-browser-registration",
          stateId: "browser-phase",
          rawAllowlist: [new URL(allowedSink.origin).host],
        },
        async () => {
          expect(
            (await ceilingManager.navigate(`${allowedSink.origin}/ceiling-allowed`)).status
          ).toBe(200);
        }
      );

      await runWithAdmittedRegisteredBrowserPolicy(
        {
          ownerScopeId: "ceiling-owner",
          invocationId: "ceiling-widen-attempt",
          registrationName: "synthetic-browser-registration",
          stateId: "browser-phase",
          rawAllowlist: [new URL(forbiddenSink.origin).host],
        },
        async () => {
          expect(ceilingManager.getPolicyStatus()).toMatchObject({
            mode: "deny-all",
            invocationPolicyPresent: true,
          });
          await expect(
            ceilingManager.navigate(`${forbiddenSink.origin}/ceiling-widen-denied`)
          ).rejects.toBeInstanceOf(BrowserPolicyViolationError);
          await expect(
            ceilingManager.navigate(`${allowedSink.origin}/empty-intersection-denied`)
          ).rejects.toBeInstanceOf(BrowserPolicyViolationError);
        }
      );

      expect(allowedSink.counts.get("/ceiling-allowed")).toBe(1);
      expect(forbiddenSink.counts.get("/ceiling-widen-denied") ?? 0).toBe(0);
      expect(allowedSink.counts.get("/empty-intersection-denied") ?? 0).toBe(0);
    } finally {
      await ceilingManager.cleanup();
    }
  });

  it("preserves the registered policy across tab switches and a recreated browser context", async () => {
    const allowedAuthority = new URL(allowedSink.origin).host;

    await runWithAdmittedRegisteredBrowserPolicy(
      {
        ownerScopeId: "lifecycle-owner",
        invocationId: "lifecycle-invocation",
        rawAllowlist: [allowedAuthority],
      },
      async () => {
        expect((await manager.navigate(`${allowedSink.origin}/lifecycle-first`)).status).toBe(200);
        const second = await manager.newPage(`${allowedSink.origin}/lifecycle-second`);
        expect(second.pageId).toBe("1");

        manager.switchTab("0");
        await expect(
          manager.navigate(`${forbiddenSink.origin}/lifecycle-tab-zero-denied`)
        ).rejects.toBeInstanceOf(BrowserPolicyViolationError);
        manager.switchTab("1");
        await expect(
          manager.navigate(`${forbiddenSink.origin}/lifecycle-tab-one-denied`)
        ).rejects.toBeInstanceOf(BrowserPolicyViolationError);

        await manager.cleanupCurrentScope();
        expect(manager.getPolicyStatus()).toMatchObject({
          mode: "allow",
          invocationPolicyPresent: true,
        });
        expect((await manager.navigate(`${allowedSink.origin}/lifecycle-recreated`)).status).toBe(
          200
        );
        await expect(
          manager.navigate(`${forbiddenSink.origin}/lifecycle-recreated-denied`)
        ).rejects.toBeInstanceOf(BrowserPolicyViolationError);
      }
    );

    expect(allowedSink.counts.get("/lifecycle-first")).toBe(1);
    expect(allowedSink.counts.get("/lifecycle-second")).toBe(1);
    expect(allowedSink.counts.get("/lifecycle-recreated")).toBe(1);
    expect(
      [...forbiddenSink.counts.entries()]
        .filter(([path]) => path.startsWith("/lifecycle-"))
        .reduce((total, [, count]) => total + count, 0)
    ).toBe(0);
  });

  it("force-kills the owned browser process when graceful cleanup hangs", async () => {
    let ownedProcess: ChildProcess | undefined;
    let exitObserved = false;
    const hangingManager = BrowserManager.createForTesting(testConfig(), {
      beforeGracefulCleanup: () => new Promise<void>(() => {}),
      onBrowserProcessOwned(browserProcess) {
        ownedProcess = browserProcess;
        browserProcess.once("exit", () => {
          exitObserved = true;
        });
      },
    });

    await runWithAdmittedRegisteredBrowserPolicy(
      {
        ownerScopeId: "hanging-close-owner",
        invocationId: "hanging-close-invocation",
        rawAllowlist: [new URL(allowedSink.origin).host],
      },
      async () => {
        const handle = hangingManager.captureCurrentScope();
        expect((await hangingManager.navigate(`${allowedSink.origin}/hanging-close`)).status).toBe(
          200
        );
        expect(hangingManager.hasOwnedLiveBrowserProcess()).toBe(true);
        await hangingManager.cleanupCapturedScope(handle);
      }
    );

    if (ownedProcess === undefined) throw new Error("browser process ownership was not observed");
    expect(exitObserved).toBe(true);
    expect(ownedProcess.exitCode !== null || ownedProcess.signalCode !== null).toBe(true);
    expect(hangingManager.isAnyScopeConnected()).toBe(false);
    expect(hangingManager.hasOwnedLiveBrowserProcess()).toBe(false);
  }, 20_000);

  it("reclaims completed production-carrier sessions beyond the concurrent binding cap", async () => {
    await manager.cleanup();
    const sequentialPath = "/sequential-completed-session";
    for (let index = 0; index < 130; index++) {
      await runWithAdmittedRegisteredBrowserPolicy(
        {
          ownerScopeId: `actual-sequential-owner-${index}`,
          invocationId: `actual-sequential-invocation-${index}`,
          rawAllowlist: [new URL(allowedSink.origin).host],
        },
        async () => {
          const handle = manager.captureCurrentScope();
          try {
            expect((await manager.navigate(`${allowedSink.origin}${sequentialPath}`)).status).toBe(
              200
            );
          } finally {
            await manager.cleanupCapturedScope(handle);
          }
        }
      );
    }
    expect(allowedSink.counts.get(sequentialPath)).toBe(130);
    expect(manager.hasOwnedLiveBrowserProcess()).toBe(false);
  }, 240_000);

  it("fails closed and removes the browser when restricted policy setup fails", async () => {
    const failingManager = BrowserManager.createForTesting(testConfig(), {
      beforeRestrictedPolicySetup() {
        throw new Error("synthetic setup failure");
      },
    });
    try {
      await runWithAdmittedRegisteredBrowserPolicy(
        {
          ownerScopeId: "setup-failure-owner",
          invocationId: "setup-failure-invocation",
          rawAllowlist: [new URL(allowedSink.origin).host],
        },
        async () => {
          await expect(
            failingManager.navigate(`${allowedSink.origin}/setup-must-not-request`)
          ).rejects.toMatchObject({ code: "BROWSER_POLICY_SETUP_FAILED" });
          expect(failingManager.isAnyScopeConnected()).toBe(false);
          expect(failingManager.hasOwnedLiveBrowserProcess()).toBe(false);
        }
      );
      expect(allowedSink.counts.get("/setup-must-not-request") ?? 0).toBe(0);
    } finally {
      await failingManager.cleanup();
    }
  });

  it("enforces the immutable process ceiling without an invocation carrier", async () => {
    await BrowserManager.resetForTesting();
    manager = BrowserManager.getBrowser(testConfig([new URL(allowedSink.origin).host]));

    expect((await manager.navigate(`${allowedSink.origin}/process-allowed`)).status).toBe(200);
    await expect(manager.navigate(`${forbiddenSink.origin}/process-denied`)).rejects.toBeInstanceOf(
      BrowserPolicyViolationError
    );
    expect(allowedSink.counts.get("/process-allowed")).toBe(1);
    expect(forbiddenSink.counts.get("/process-denied") ?? 0).toBe(0);
  });
});
