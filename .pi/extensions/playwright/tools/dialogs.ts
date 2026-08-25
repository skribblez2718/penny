import { registerTool } from "../../../lib/pi-tool-registration.js";
/**
 * Dialogs, Console & Network Tools
 *
 * browser_handle_dialog, browser_console_messages, browser_network_requests
 *
 * Translated from MCP: dialogs.ts, console.ts, network.ts
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Dialog, ConsoleMessage, Request, Response } from "playwright";
import { BrowserManager } from "../browser.js";
import type { PlaywrightConfig } from "../types.js";

export function registerDialogNetworkTools(pi: ExtensionAPI, _config: PlaywrightConfig) {
  const browser = BrowserManager.getBrowser();

  // ==========================================================================
  // playwright_handle_dialog
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_handle_dialog",
    label: "Handle Dialog",
    description:
      "Accept or dismiss a browser dialog (alert, confirm, prompt, beforeunload). Use this when the page shows a JavaScript dialog that blocks interaction.",
    promptSnippet: "Accept or dismiss a browser dialog",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("accept"), Type.Literal("dismiss")], {
        description: "Accept or dismiss the dialog",
      }),
      promptText: Type.Optional(
        Type.String({
          description: "Text to enter for prompt dialogs (only with accept)",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const action = params.action;
      const timeoutMs = 10000;

      try {
        // Remove default auto-dismiss handler and take control
        page.removeAllListeners("dialog");

        // Set up our handler that waits up to timeoutMs
        const dialogPromise = new Promise<{ type: string; message: string }>((resolve, reject) => {
          const timeout = setTimeout(() => {
            page.off("dialog", handler);
            // Re-install auto-dismiss on timeout
            page.on("dialog", async (dialog) => {
              await dialog.dismiss().catch(() => {});
            });
            reject(new Error("timeout"));
          }, timeoutMs);

          const handler = async (dialog: Dialog) => {
            clearTimeout(timeout);
            page.off("dialog", handler);
            // Re-install auto-dismiss after handling
            page.on("dialog", async (d) => {
              await d.dismiss().catch(() => {});
            });
            const info = {
              type: dialog.type(),
              message: dialog.message(),
            };
            if (action === "accept") {
              await dialog.accept(params.promptText ?? "");
            } else {
              await dialog.dismiss();
            }
            resolve(info);
          };

          page.on("dialog", handler);
        });

        const dialogInfo = await dialogPromise;

        return {
          content: [
            {
              type: "text",
              text: `${action === "accept" ? "Accepted" : "Dismissed"} ${dialogInfo.type} dialog: "${dialogInfo.message.slice(0, 100)}"`,
            },
          ],
          details: {
            dialogType: dialogInfo.type,
            message: dialogInfo.message,
            action,
          },
        };
      } catch (err) {
        if (err instanceof Error && err.message === "timeout") {
          return {
            content: [
              {
                type: "text",
                text: `No dialog appeared within 3 seconds. Make sure a dialog was triggered by a previous interaction.`,
              },
            ],
            details: { handled: false },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Dialog handling failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_console_messages
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_console_messages",
    label: "Console Messages",
    description:
      "Capture console messages from the page (log, error, warn, info, debug). Use this for debugging JavaScript execution and viewing page errors.",
    promptSnippet: "View browser console messages",
    parameters: Type.Object({
      level: Type.Optional(
        Type.Union([
          Type.Literal("error"),
          Type.Literal("warning"),
          Type.Literal("info"),
          Type.Literal("log"),
          Type.Literal("debug"),
        ])
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Max messages to return (default: 50)",
          minimum: 1,
          maximum: 200,
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const level = params.level;
      const limit = params.limit ?? 50;

      try {
        // Playwright doesn't expose past console messages via the API. Instead we
        // attach a listener, collect messages going forward for a short window,
        // and return what we captured.
        const collected: Array<{ type: string; text: string; timestamp: number }> = [];

        const handler = (msg: ConsoleMessage) => {
          const type = msg.type();
          if (!level || type === level) {
            collected.push({
              type,
              text: msg.text().slice(0, 500),
              timestamp: Date.now(),
            });
          }
        };

        page.on("console", handler);

        // Wait a tiny bit to collect any pending messages
        await page.waitForTimeout(100);
        page.off("console", handler);

        const result = collected.slice(0, limit);

        return {
          content: [
            {
              type: "text",
              text:
                result.length === 0
                  ? "No console messages captured."
                  : JSON.stringify(result, null, 2),
            },
          ],
          details: {
            entries: result,
            totalCaptured: result.length,
            filtered: level ? `level=${level}` : "all",
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Console capture failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_network_requests
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_network_requests",
    label: "Network Requests",
    description:
      "Capture a brief, forward-looking sample of page network requests with optional resource-type filtering. Start this tool before the interaction whose API calls you need to observe; use playwright_network_request afterward for timing and size details of a discovered URL.",
    promptSnippet: "View page network requests",
    parameters: Type.Object({
      resourceTypes: Type.Optional(
        Type.Array(
          Type.Union([
            Type.Literal("document"),
            Type.Literal("stylesheet"),
            Type.Literal("image"),
            Type.Literal("media"),
            Type.Literal("font"),
            Type.Literal("script"),
            Type.Literal("xhr"),
            Type.Literal("fetch"),
            Type.Literal("websocket"),
            Type.Literal("other"),
          ])
        )
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Max requests to return (default: 50)",
          minimum: 1,
          maximum: 200,
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const types = params.resourceTypes;
      const limit = params.limit ?? 50;

      try {
        const requests: Array<{
          url: string;
          method: string;
          resourceType: string;
          status: number;
        }> = [];

        const handler = (request: Request) => {
          const resourceType = request.resourceType();
          if (!types || types.some((type) => type === resourceType)) {
            requests.push({
              url: request.url(),
              method: request.method(),
              resourceType,
              status: 0, // Not yet available at request time
            });
          }
        };

        const responseHandler = (response: Response) => {
          const url = response.url();
          const existing = requests.find((r) => r.url === url);
          if (existing) {
            existing.status = response.status();
          }
        };

        page.on("request", handler);
        page.on("response", responseHandler);

        // Collect briefly
        await page.waitForTimeout(300);
        page.off("request", handler);
        page.off("response", responseHandler);

        const result = requests.slice(0, limit);

        return {
          content: [
            {
              type: "text",
              text:
                result.length === 0
                  ? "No network requests captured."
                  : JSON.stringify(result, null, 2),
            },
          ],
          details: {
            requests: result,
            totalCaptured: result.length,
            filteredBy: types ? `types=${types.join(",")}` : "all",
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Network capture failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_network_request (single request details)
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_network_request",
    label: "Network Request Details",
    description:
      "Return browser performance timing and transfer-size details for the first resource URL containing a pattern. Use playwright_network_requests first to discover the relevant URL; this tool does not return request headers or response bodies.",
    promptSnippet: "View details of a specific network request",
    parameters: Type.Object({
      urlPattern: Type.String({
        description: "URL or pattern to match the request (partial match)",
      }),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const urlPattern = params.urlPattern;

      try {
        const details = await page.evaluate((pattern) => {
          // Access performance API entries
          const entries = performance.getEntriesByType("resource");
          const matches = entries.filter(
            (entry): entry is PerformanceResourceTiming =>
              entry instanceof PerformanceResourceTiming && entry.name.includes(pattern)
          );

          if (matches.length === 0) return null;

          const match = matches[0];
          return {
            url: match.name,
            duration: Math.round(match.duration),
            startTime: Math.round(match.startTime),
            transferSize: match.transferSize,
            encodedBodySize: match.encodedBodySize,
            decodedBodySize: match.decodedBodySize,
            initiatorType: match.initiatorType,
            domainLookup: Math.round(match.domainLookupEnd - match.domainLookupStart),
            connect: Math.round(match.connectEnd - match.connectStart),
            response: Math.round(match.responseEnd - match.responseStart),
          };
        }, urlPattern);

        if (!details) {
          return {
            content: [
              {
                type: "text",
                text: `No request found matching "${urlPattern}". Try playwright_network_requests first to discover request URLs.`,
              },
            ],
            details: { found: false },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(details, null, 2),
            },
          ],
          details,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Network request details failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
