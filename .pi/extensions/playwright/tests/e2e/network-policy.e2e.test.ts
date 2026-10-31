import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import playwrightExtension from "../../index.js";
import { BrowserManager, BrowserPolicyViolationError } from "../../browser.js";
import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { isRecord } from "../../../../lib/tests/test-narrowers.js";
import { runWithAdmittedRegisteredBrowserPolicy } from "../helpers/registered-browser-policy.js";

const browserTestsEnabled = process.env.PENNY_PLAYWRIGHT_BROWSER_TESTS === "1";
const browserDescribe = browserTestsEnabled ? describe : describe.skip;

interface RegisteredTool {
  name: string;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<unknown>;
}

interface RegisteredEventHandler {
  (event: unknown, context: unknown): unknown;
}

function isRegisteredTool(value: unknown): value is RegisteredTool {
  return isRecord(value) && typeof value.name === "string" && typeof value.execute === "function";
}

function isRegisteredEventHandler(value: unknown): value is RegisteredEventHandler {
  return typeof value === "function";
}

function resultIsPolicyDenial(value: unknown): boolean {
  if (!isRecord(value) || value.isError !== true || !isRecord(value.details)) return false;
  return value.details.reasonCode === "BROWSER_RESTRICTED_OPERATION_DENIED";
}

function resultHasNumericNodeCount(value: unknown): boolean {
  return isRecord(value) && isRecord(value.details) && typeof value.details.nodeCount === "number";
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing loopback address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

let allowedServer: Server;
let forbiddenServer: Server;
let allowedOrigin: string;
let forbiddenOrigin: string;
let forbiddenRequests = 0;
let savedHeadless: string | undefined;
let savedAllowlist: string | undefined;

beforeAll(async () => {
  if (!browserTestsEnabled) return;
  await BrowserManager.resetForTesting();
  allowedServer = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!doctype html><title>allowed tool path</title><h1>allowed</h1>");
  });
  forbiddenServer = createServer((_request, response) => {
    forbiddenRequests++;
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!doctype html><title>forbidden</title>");
  });
  [allowedOrigin, forbiddenOrigin] = await Promise.all([
    listen(allowedServer),
    listen(forbiddenServer),
  ]);

  savedHeadless = process.env.PLAYWRIGHT_HEADLESS;
  savedAllowlist = process.env.PLAYWRIGHT_NETWORK_ALLOWLIST;
  process.env.PLAYWRIGHT_HEADLESS = "1";
  process.env.PLAYWRIGHT_NETWORK_ALLOWLIST = "";
});

afterAll(async () => {
  if (!browserTestsEnabled) return;
  await BrowserManager.getBrowser().cleanup();
  await Promise.all([close(allowedServer), close(forbiddenServer)]);
  await BrowserManager.resetForTesting();
  if (savedHeadless === undefined) delete process.env.PLAYWRIGHT_HEADLESS;
  else process.env.PLAYWRIGHT_HEADLESS = savedHeadless;
  if (savedAllowlist === undefined) delete process.env.PLAYWRIGHT_NETWORK_ALLOWLIST;
  else process.env.PLAYWRIGHT_NETWORK_ALLOWLIST = savedAllowlist;
});

browserDescribe("registered Playwright tool network policy", () => {
  it("enforces the admitted orchestration policy through production tool adapters", async () => {
    const authority = new URL(allowedOrigin).host;
    await runWithAdmittedRegisteredBrowserPolicy(
      {
        ownerScopeId: "e2e-owner",
        invocationId: "e2e-invocation",
        rawAllowlist: [authority],
      },
      async () => {
        const registeredTools = new Map<string, RegisteredTool>();
        const registeredEvents = new Map<string, RegisteredEventHandler>();
        const pi = createTestExtensionApi({
          onRegisterTool(tool) {
            if (!isRegisteredTool(tool)) throw new Error("invalid registered tool");
            registeredTools.set(tool.name, tool);
          },
          onEvent(event, handler) {
            if (!isRegisteredEventHandler(handler)) throw new Error(`invalid ${event} handler`);
            registeredEvents.set(event, handler);
          },
        });
        // Extension loading occurs inside the real orchestration carrier, just as
        // createAgentSession loads production extensions before any tool executes.
        playwrightExtension(pi);
        const navigateTool = registeredTools.get("playwright_navigate");
        const sessionStart = registeredEvents.get("session_start");
        const sessionShutdown = registeredEvents.get("session_shutdown");
        if (navigateTool === undefined) throw new Error("playwright_navigate was not registered");
        if (sessionStart === undefined || sessionShutdown === undefined) {
          throw new Error("Playwright lifecycle handlers were not registered");
        }

        await sessionStart(
          {},
          {
            cwd: process.cwd(),
            sessionManager: { getSessionId: () => "e2e-production-carrier" },
          }
        );
        try {
          const allowed = await navigateTool.execute("allowed-call", { url: allowedOrigin });
          expect(allowed).toMatchObject({
            details: {
              result: { status: 200 },
            },
          });
          const denial = await navigateTool
            .execute("forbidden-call", { url: `${forbiddenOrigin}/secret?token=sensitive-value` })
            .then(
              () => null,
              (error: unknown) => error
            );
          expect(denial).toBeInstanceOf(BrowserPolicyViolationError);
          if (!(denial instanceof Error)) throw new Error("forbidden navigation did not fail");
          expect(denial.message).not.toContain("/secret");
          expect(denial.message).not.toContain("sensitive-value");

          const bypassCalls: readonly [string, Record<string, unknown>][] = [
            ["playwright_route", { urlPattern: "**/*", action: "fulfill", body: "bypass" }],
            ["playwright_unroute", {}],
            ["playwright_check_proxy_reachable", {}],
            ["playwright_set_proxy", { action: "custom", server: forbiddenOrigin }],
            ["playwright_run_code_unsafe", { code: "return process.env" }],
          ];
          for (const [name, params] of bypassCalls) {
            const tool = registeredTools.get(name);
            if (tool === undefined) throw new Error(`${name} was not registered`);
            expect(resultIsPolicyDenial(await tool.execute(`denied-${name}`, params)), name).toBe(
              true
            );
          }
        } finally {
          await sessionShutdown({}, {});
        }
      }
    );
    expect(forbiddenRequests).toBe(0);
  });

  it("single-flights concurrent first-use production tools in one scope", async () => {
    const authority = new URL(allowedOrigin).host;
    await runWithAdmittedRegisteredBrowserPolicy(
      {
        ownerScopeId: "e2e-concurrent-owner",
        invocationId: "e2e-concurrent-invocation",
        rawAllowlist: [authority],
      },
      async () => {
        const registeredTools = new Map<string, RegisteredTool>();
        const registeredEvents = new Map<string, RegisteredEventHandler>();
        const pi = createTestExtensionApi({
          onRegisterTool(tool) {
            if (!isRegisteredTool(tool)) throw new Error("invalid registered tool");
            registeredTools.set(tool.name, tool);
          },
          onEvent(event, handler) {
            if (!isRegisteredEventHandler(handler)) throw new Error(`invalid ${event} handler`);
            registeredEvents.set(event, handler);
          },
        });
        playwrightExtension(pi);

        const currentUrlTool = registeredTools.get("playwright_get_current_url");
        const snapshotTool = registeredTools.get("playwright_snapshot");
        const sessionStart = registeredEvents.get("session_start");
        const sessionShutdown = registeredEvents.get("session_shutdown");
        if (currentUrlTool === undefined || snapshotTool === undefined) {
          throw new Error("Concurrent first-use tools were not registered");
        }
        if (sessionStart === undefined || sessionShutdown === undefined) {
          throw new Error("Playwright lifecycle handlers were not registered");
        }

        await sessionStart(
          {},
          {
            cwd: process.cwd(),
            sessionManager: { getSessionId: () => "e2e-concurrent-production-carrier" },
          }
        );
        const browserManager = BrowserManager.getBrowser();
        try {
          const [currentUrl, snapshot] = await Promise.all([
            currentUrlTool.execute("concurrent-current-url", {}),
            snapshotTool.execute("concurrent-snapshot", {}),
          ]);
          expect(currentUrl).toMatchObject({ details: { url: "about:blank" } });
          expect(resultHasNumericNodeCount(snapshot)).toBe(true);
          expect(browserManager.hasOwnedLiveBrowserProcess()).toBe(true);
        } finally {
          await sessionShutdown({}, {});
        }
        expect(browserManager.isAnyScopeConnected()).toBe(false);
        expect(browserManager.hasOwnedLiveBrowserProcess()).toBe(false);
      }
    );
  });
});
