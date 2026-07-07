/**
 * Storage Tools — localStorage, sessionStorage, Cookies
 *
 * Translated from MCP: webstorage.ts, cookies.ts, storage.ts
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BrowserManager } from "../browser.js";
import type { PlaywrightConfig } from "../types.js";

export function registerStorageTools(pi: ExtensionAPI, _config: PlaywrightConfig) {
  const browser = BrowserManager.getBrowser();

  // ==========================================================================
  // playwright_local_storage
  // ==========================================================================
  pi.registerTool({
    name: "playwright_local_storage",
    label: "Local Storage",
    description: "Get, set, or list localStorage entries for the current page origin.",
    promptSnippet: "Read/write browser localStorage",
    promptGuidelines: [
      "Use playwright_local_storage to inspect or modify localStorage.",
      "For security testing: check for sensitive data stored in localStorage (tokens, user data).",
      "Each origin has its own isolated localStorage.",
    ],
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("get"),
          Type.Literal("set"),
          Type.Literal("remove"),
          Type.Literal("clear"),
          Type.Literal("getAll"),
        ],
        { description: "Operation to perform" }
      ),
      key: Type.Optional(
        Type.String({
          description: "Key name (required for get, set, remove)",
        })
      ),
      value: Type.Optional(
        Type.String({
          description: "Value to set (required for set)",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const action = params.action as string;

      try {
        let result: string;
        switch (action) {
          case "get": {
            const val = await page.evaluate((k) => localStorage.getItem(k), params.key as string);
            result = val !== null ? val : `[not found: ${params.key}]`;
            break;
          }
          case "set": {
            await page.evaluate(({ k, v }) => localStorage.setItem(k, v), {
              k: params.key,
              v: params.value,
            });
            result = `Set "${params.key}"`;
            break;
          }
          case "remove": {
            await page.evaluate((k) => localStorage.removeItem(k), params.key as string);
            result = `Removed "${params.key}"`;
            break;
          }
          case "clear": {
            await page.evaluate(() => localStorage.clear());
            result = "Cleared all localStorage";
            break;
          }
          case "getAll": {
            const all = await page.evaluate(() => {
              const items: Record<string, string> = {};
              for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key === null) continue;
                items[key] = localStorage.getItem(key) || "";
              }
              return items;
            });
            result = JSON.stringify(all, null, 2);
            break;
          }
          default:
            result = `Unknown action: ${action}`;
        }
        return {
          content: [{ type: "text", text: result }],
          details: { action, key: params.key },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Storage operation failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_session_storage
  // ==========================================================================
  pi.registerTool({
    name: "playwright_session_storage",
    label: "Session Storage",
    description: "Get, set, or list sessionStorage entries for the current page origin.",
    promptSnippet: "Read/write browser sessionStorage",
    promptGuidelines: [
      "Use playwright_session_storage to inspect sessionStorage.",
      "sessionStorage is cleared when the tab is closed.",
    ],
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("get"),
          Type.Literal("set"),
          Type.Literal("remove"),
          Type.Literal("clear"),
          Type.Literal("getAll"),
        ],
        { description: "Operation" }
      ),
      key: Type.Optional(Type.String({ description: "Key name" })),
      value: Type.Optional(Type.String({ description: "Value to set" })),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const action = params.action as string;
      const storage = "sessionStorage";

      try {
        const result = await page.evaluate(
          ({ s, a, k, v }: { s: string; a: string; k?: string; v?: string }) => {
            const store = s === "sessionStorage" ? sessionStorage : localStorage;
            switch (a) {
              case "get":
                if (k === undefined) return "[error: key is required for get]";
                return store.getItem(k) ?? `[not found: ${k}]`;
              case "set":
                if (k === undefined || v === undefined)
                  return "[error: key and value are required for set]";
                store.setItem(k, v);
                return `Set "${k}"`;
              case "remove":
                if (k === undefined) return "[error: key is required for remove]";
                store.removeItem(k);
                return `Removed "${k}"`;
              case "clear":
                store.clear();
                return "Cleared all";
              case "getAll": {
                const items: Record<string, string> = {};
                for (let i = 0; i < store.length; i++) {
                  const key = store.key(i);
                  if (key === null) continue;
                  items[key] = store.getItem(key) || "";
                }
                return JSON.stringify(items, null, 2);
              }
              default:
                return `Unknown action: ${a}`;
            }
          },
          { s: storage, a: action, k: params.key as string, v: params.value as string }
        );

        return {
          content: [{ type: "text", text: result }],
          details: { action, storage },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Storage failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_cookies
  // ==========================================================================
  pi.registerTool({
    name: "playwright_cookies",
    label: "Browser Cookies",
    description: "List, get, set, or clear browser cookies for the current page.",
    promptSnippet: "Read/write browser cookies",
    promptGuidelines: [
      "Use playwright_cookies to inspect or manage cookies.",
      "For security testing: check for HttpOnly, Secure flags, session tokens.",
    ],
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("list"), Type.Literal("get"), Type.Literal("set"), Type.Literal("clear")],
        { description: "Operation" }
      ),
      name: Type.Optional(
        Type.String({
          description: "Cookie name (for get/set)",
        })
      ),
      value: Type.Optional(
        Type.String({
          description: "Cookie value (for set)",
        })
      ),
      domain: Type.Optional(Type.String({ description: "Domain (for set)" })),
      path: Type.Optional(Type.String({ description: "Path (for set, default /)" })),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const action = params.action as string;

      try {
        let result: string;
        const context = page.context();

        switch (action) {
          case "list": {
            const cookies = await context.cookies();
            result = JSON.stringify(cookies, null, 2);
            break;
          }
          case "clear": {
            await context.clearCookies();
            result = "All cookies cleared";
            break;
          }
          case "set": {
            await context.addCookies([
              {
                name: (params.name as string) || "",
                value: (params.value as string) || "",
                domain: (params.domain as string) || new URL(page.url()).hostname,
                path: (params.path as string) || "/",
              },
            ]);
            result = `Cookie "${params.name}" set`;
            break;
          }
          case "get": {
            const cookies = await context.cookies();
            const cookie = cookies.find((c) => c.name === params.name);
            result = cookie ? JSON.stringify(cookie, null, 2) : `Cookie "${params.name}" not found`;
            break;
          }
          default:
            result = `Unknown action: ${action}`;
        }

        return {
          content: [{ type: "text", text: result }],
          details: { action },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Cookie operation failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
