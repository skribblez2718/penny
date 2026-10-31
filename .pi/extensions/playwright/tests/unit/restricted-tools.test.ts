import { afterEach, describe, expect, it } from "vitest";

import { BrowserManager } from "../../browser.js";
import { registerPdfTools } from "../../tools/pdf.js";
import { registerProxyTools } from "../../tools/proxy.js";
import { registerRouteFormFileTools } from "../../tools/routes.js";
import type { PlaywrightConfig } from "../../types.js";
import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { isRecord } from "../../../../lib/tests/test-narrowers.js";
import { runWithAdmittedRegisteredBrowserPolicy } from "../helpers/registered-browser-policy.js";

interface RegisteredTool {
  name: string;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<unknown>;
}

function isRegisteredTool(value: unknown): value is RegisteredTool {
  return isRecord(value) && typeof value.name === "string" && typeof value.execute === "function";
}

function config(): PlaywrightConfig {
  return {
    headless: true,
    timeout: 5_000,
    networkAllowlist: [],
    downloadDir: "/tmp",
    outputDir: "/tmp",
    enableVision: false,
    enableDevtools: false,
    enableNetwork: true,
    enableStorage: false,
    allowUnsafe: true,
    ignoreHTTPSErrors: false,
  };
}

function resultIsPolicyDenial(value: unknown): boolean {
  if (!isRecord(value) || value.isError !== true || !isRecord(value.details)) return false;
  return value.details.reasonCode === "BROWSER_RESTRICTED_OPERATION_DENIED";
}

afterEach(async () => {
  await BrowserManager.resetForTesting();
});

describe("restricted tool execution", () => {
  it("refuses page routing, proxy bypasses, and unsafe code through the admitted production carrier", async () => {
    const tools = new Map<string, RegisteredTool>();
    const pi = createTestExtensionApi({
      onRegisterTool(tool) {
        if (!isRegisteredTool(tool)) throw new Error("invalid registered Playwright tool");
        tools.set(tool.name, tool);
      },
    });
    const testConfig = config();
    BrowserManager.getBrowser(testConfig);
    registerRouteFormFileTools(pi, testConfig);
    registerProxyTools(pi, testConfig);
    registerPdfTools(pi, testConfig);

    const calls: readonly [string, Record<string, unknown>][] = [
      ["playwright_route", { urlPattern: "**/*", action: "fulfill", body: "bypass" }],
      ["playwright_unroute", {}],
      ["playwright_check_proxy_reachable", {}],
      ["playwright_set_proxy", { action: "custom", server: "http://127.0.0.1:9" }],
      ["playwright_run_code_unsafe", { code: "return process.env" }],
    ];

    await runWithAdmittedRegisteredBrowserPolicy(
      {
        ownerScopeId: "registered-tool-owner",
        invocationId: "registered-tool-invocation",
        rawAllowlist: ["https://allowed.example"],
      },
      async () => {
        for (const [name, params] of calls) {
          const tool = tools.get(name);
          if (tool === undefined) throw new Error(`tool ${name} was not registered`);
          expect(resultIsPolicyDenial(await tool.execute(`call-${name}`, params)), name).toBe(true);
        }
      }
    );

    expect(BrowserManager.getEffectiveProxy(testConfig)).toBeUndefined();
  });
});
