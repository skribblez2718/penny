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

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PlaywrightConfig, ProxyConfig } from "../types.js";
import { BrowserManager } from "../browser.js";

export function registerProxyTools(pi: ExtensionAPI, config: PlaywrightConfig) {
  // ==========================================================================
  // playwright_get_proxy_info
  // ==========================================================================
  pi.registerTool({
    name: "playwright_get_proxy_info",
    label: "Get Proxy Info",
    description:
      "Return the currently configured proxy settings for Playwright browser traffic. Returns server URL, username (if any), bypass list (if any), and a sanitized summary safe to log. Does NOT include the password in the response.",
    promptSnippet: "Get current proxy configuration",
    promptGuidelines: [
      "Use playwright_get_proxy_info to verify the proxy is configured before relying on HTTP history capture.",
      "The response is safe to log — the password is never returned.",
      "If proxy is null, browser traffic is direct (no proxy).",
    ],
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
  pi.registerTool({
    name: "playwright_check_proxy_reachable",
    label: "Check Proxy Reachability",
    description:
      "Check whether the configured proxy is currently reachable. Returns latency in milliseconds and reachable status.",
    promptSnippet: "Check if proxy is reachable",
    promptGuidelines: [
      "Use playwright_check_proxy_reachable to verify the proxy is up before assuming HTTP history will be captured.",
      "Returns reachable (boolean), latencyMs, and error if unreachable.",
      "If no proxy is configured, returns reachable=false with explanation.",
    ],
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
  pi.registerTool({
    name: "playwright_set_proxy",
    label: "Set Browser Proxy",
    description:
      "Route Playwright browser traffic through a custom proxy, or turn the proxy OFF (direct), at runtime. The running browser is closed so the change applies on the next navigation.",
    promptSnippet: "Toggle the browser proxy: off | custom",
    promptGuidelines: [
      "Playwright runs DIRECT by default. Call with action='custom' and an explicit server to enable a proxy, then action='off' to return to direct.",
      "The current browser/page/tabs are closed so the next navigate relaunches with the new proxy.",
      "After configuring a proxy, use playwright_check_proxy_reachable before relying on it.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("off"), Type.Literal("custom")], {
        description: "off = direct (no proxy); custom = a server you provide",
      }),
      server: Type.Optional(
        Type.String({
          description: "Proxy server URL for action='custom', e.g. http://127.0.0.1:8080",
        })
      ),
      username: Type.Optional(Type.String({ description: "Proxy auth username (optional)" })),
      password: Type.Optional(Type.String({ description: "Proxy auth password (optional)" })),
      bypass: Type.Optional(
        Type.String({ description: "Comma-separated hosts that bypass the proxy (optional)" })
      ),
    }),
    async execute(_toolCallId, params) {
      const p = params as {
        action: "off" | "custom";
        server?: string;
        username?: string;
        password?: string;
        bypass?: string;
      };

      let proxy: ProxyConfig | null;
      let summary: string;

      if (p.action === "off") {
        proxy = null;
        summary = "Proxy disabled — browser traffic is direct.";
      } else {
        const server = (p.server || "").trim();
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
        if (p.username) proxy.username = p.username;
        if (p.password) proxy.password = p.password;
        if (p.bypass) proxy.bypass = p.bypass;
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
