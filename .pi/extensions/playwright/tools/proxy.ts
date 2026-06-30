/**
 * Proxy Tools
 *
 * Tools for inspecting and verifying Playwright's proxy configuration.
 * The actual proxy is set at browser launch via env vars or config —
 * these tools help agents confirm the configuration is active.
 *
 * Primary use case: jsa skill's STRUCTURE phase routes browser traffic
 * through Caido for HTTP history capture. These tools let agents verify
 * the proxy is configured and discover the upstream address.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BrowserManager } from "../browser.js";
import type { PlaywrightConfig } from "../types.js";

export function registerProxyTools(pi: ExtensionAPI, config: PlaywrightConfig) {
  const browser = BrowserManager.getBrowser();

  // ==========================================================================
  // playwright_get_proxy_info
  // ==========================================================================
  pi.registerTool({
    name: "playwright_get_proxy_info",
    label: "Get Proxy Info",
    description:
      "Return the currently configured proxy settings for Playwright browser traffic. Use this to verify whether a proxy (e.g., Caido) is configured. Returns server URL, username (if any), bypass list (if any), and a sanitized summary safe to log. Does NOT include the password in the response.",
    promptSnippet: "Get current proxy configuration",
    promptGuidelines: [
      "Use playwright_get_proxy_info to verify the proxy is configured before relying on HTTP history capture.",
      "The response is safe to log — the password is never returned.",
      "If proxy is null, browser traffic is direct (no proxy).",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const proxy = config.proxy;
      if (!proxy) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  proxy: null,
                  message:
                    "No proxy configured. Browser traffic is direct. Set PLAYWRIGHT_PROXY_SERVER env var to route through a proxy (e.g., Caido).",
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
      "Check whether the configured proxy is currently reachable. Returns latency in milliseconds and reachable status. Useful for verifying Caido (or another proxy) is up before relying on it for HTTP history capture.",
    promptSnippet: "Check if proxy is reachable",
    promptGuidelines: [
      "Use playwright_check_proxy_reachable to verify the proxy is up before assuming HTTP history will be captured.",
      "Returns reachable (boolean), latencyMs, and error if unreachable.",
      "If no proxy is configured, returns reachable=false with explanation.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const proxy = config.proxy;
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
}
