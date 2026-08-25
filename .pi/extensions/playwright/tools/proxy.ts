import { registerTool } from "../../../lib/pi-tool-registration.js";
/**
 * Proxy Tools
 *
 * Tools for inspecting and verifying Playwright's proxy configuration.
 * The actual proxy is set at browser launch via env vars or config —
 * these tools help agents confirm the configuration is active.
 *
 * Agents can route traffic through an explicitly configured inspection or
 * corporate proxy, verify that proxy, and return to direct browsing.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PlaywrightConfig, ProxyConfig } from "../types.js";
import { BrowserManager } from "../browser.js";

export function registerProxyTools(pi: ExtensionAPI, config: PlaywrightConfig) {
  // ==========================================================================
  // playwright_get_proxy_info
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_get_proxy_info",
    label: "Get Proxy Info",
    description:
      "Return the currently configured proxy settings for Playwright browser traffic. Returns server URL, username (if any), bypass list (if any), and a sanitized summary safe to log. Does NOT include the password in the response.",
    promptSnippet: "Get current proxy configuration",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const proxy = BrowserManager.getEffectiveProxy(config);
      if (!proxy) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  proxy: null,
                  message:
                    "No proxy configured. Browser traffic is direct. Use playwright_set_proxy(action='custom') with an explicit server, or set PLAYWRIGHT_PROXY_SERVER.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                proxy: {
                  server: proxy.server,
                  has_auth: !!proxy.username,
                  username: proxy.username || null,
                  bypass: proxy.bypass || null,
                },
                message: `Browser traffic is routed through proxy: ${proxy.server}`,
              },
              null,
              2
            ),
          },
        ],
      };
    },
  });

  // ==========================================================================
  // playwright_check_proxy_reachable
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_check_proxy_reachable",
    label: "Check Proxy Reachability",
    description:
      "Check whether the configured proxy is currently reachable before relying on proxied browser traffic. Returns latency and reachability, or an explanation when no proxy is configured.",
    promptSnippet: "Check if proxy is reachable",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const proxy = BrowserManager.getEffectiveProxy(config);
      if (!proxy) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  reachable: false,
                  latencyMs: 0,
                  error: "No proxy configured",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const start = Date.now();
      try {
        // Try a TCP connection to the proxy server
        const url = new URL(proxy.server);
        const host = url.hostname;
        const port = parseInt(url.port || (url.protocol === "https:" ? "443" : "80"), 10);

        const net = await import("node:net");
        const reachable = await new Promise<boolean>((resolve) => {
          const socket = new net.Socket();
          const timer = setTimeout(() => {
            socket.destroy();
            resolve(false);
          }, 3000);
          socket.once("connect", () => {
            clearTimeout(timer);
            socket.destroy();
            resolve(true);
          });
          socket.once("error", () => {
            clearTimeout(timer);
            socket.destroy();
            resolve(false);
          });
          socket.connect(port, host);
        });

        const latencyMs = Date.now() - start;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  reachable,
                  latencyMs,
                  host,
                  port,
                  server: proxy.server,
                  error: reachable ? null : "Connection refused or timed out",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  reachable: false,
                  latencyMs: Date.now() - start,
                  error: err instanceof Error ? err.message : String(err),
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_set_proxy — runtime toggle (off | custom)
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_set_proxy",
    label: "Set Browser Proxy",
    description:
      "Route Playwright browser traffic through an explicit custom proxy, or turn the proxy off for direct traffic. The current browser, pages, and tabs are closed; navigate again and use playwright_check_proxy_reachable before relying on the new proxy.",
    promptSnippet: "Toggle the browser proxy: off | custom",
    parameters: Type.Union([
      Type.Object({
        action: Type.Literal("off", { description: "Use direct browser traffic without a proxy" }),
      }),
      Type.Object({
        action: Type.Literal("custom", { description: "Use the supplied proxy server" }),
        server: Type.String({
          minLength: 1,
          description: "Proxy server URL, e.g. http://127.0.0.1:8080",
        }),
        username: Type.Optional(Type.String({ description: "Proxy auth username (optional)" })),
        password: Type.Optional(Type.String({ description: "Proxy auth password (optional)" })),
        bypass: Type.Optional(
          Type.String({ description: "Comma-separated hosts that bypass the proxy (optional)" })
        ),
      }),
    ]),
    async execute(_toolCallId, params) {
      let proxy: ProxyConfig | null;
      let summary: string;

      if (params.action === "off") {
        proxy = null;
        summary = "Proxy disabled — browser traffic is direct.";
      } else {
        const server = (params.server || "").trim();
        if (!server) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { error: "action='custom' requires a 'server' URL." },
                  null,
                  2
                ),
              },
            ],
          };
        }
        proxy = { server };
        if (params.username) proxy.username = params.username;
        if (params.password) proxy.password = params.password;
        if (params.bypass) proxy.bypass = params.bypass;
        summary = `Browser traffic will route through proxy: ${server}`;
      }

      BrowserManager.setProxyOverride(proxy);

      // Close the running browser so the next navigation relaunches with the new proxy.
      let browserRelaunched = false;
      const manager = BrowserManager.getBrowser();
      if (manager.isConnected()) {
        await manager.cleanup();
        browserRelaunched = true;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                proxy: proxy
                  ? {
                      server: proxy.server,
                      has_auth: !!proxy.username,
                      bypass: proxy.bypass || null,
                    }
                  : null,
                browser_relaunched: browserRelaunched,
                message: `${summary} Applies on the next navigation${browserRelaunched ? "; the previous browser session was closed" : ""}.`,
              },
              null,
              2
            ),
          },
        ],
      };
    },
  });
}
