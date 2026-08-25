import { registerTool } from "../../../lib/pi-tool-registration.js";
/**
 * Storage Tools — localStorage, sessionStorage, Cookies
 *
 * Translated from MCP: webstorage.ts, cookies.ts, storage.ts
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BrowserManager } from "../browser.js";
import type { PlaywrightConfig } from "../types.js";

export function registerStorageTools(pi: ExtensionAPI, _config: PlaywrightConfig) {
  const browser = BrowserManager.getBrowser();

  // ==========================================================================
  // playwright_local_storage
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_local_storage",
    label: "Local Storage",
    description: "Get, set, or list localStorage entries for the current page origin.",
    promptSnippet: "Read/write browser localStorage",
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
      const { action } = params;

      try {
        let result: string;
        switch (action) {
          case "get": {
            if (params.key === undefined) {
              return {
                content: [{ type: "text", text: "A key is required for get." }],
                isError: true,
              };
            }
            const val = await page.evaluate((key) => localStorage.getItem(key), params.key);
            result = val !== null ? val : `[not found: ${params.key}]`;
            break;
          }
          case "set": {
            if (params.key === undefined || params.value === undefined) {
              return {
                content: [{ type: "text", text: "A key and value are required for set." }],
                isError: true,
              };
            }
            await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
              key: params.key,
              value: params.value,
            });
            result = `Set "${params.key}"`;
            break;
          }
          case "remove": {
            if (params.key === undefined) {
              return {
                content: [{ type: "text", text: "A key is required for remove." }],
                isError: true,
              };
            }
            await page.evaluate((key) => localStorage.removeItem(key), params.key);
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
  registerTool(pi, {
    name: "playwright_session_storage",
    label: "Session Storage",
    description: "Get, set, or list sessionStorage entries for the current page origin.",
    promptSnippet: "Read/write browser sessionStorage",
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
      const action = params.action;
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
          { s: storage, a: action, k: params.key, v: params.value }
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
  registerTool(pi, {
    name: "playwright_cookies",
    label: "Browser Cookies",
    description: "List, get, set, or clear browser cookies for the current page.",
    promptSnippet: "Read/write browser cookies",
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
      const action = params.action;

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
                name: params.name || "",
                value: params.value || "",
                domain: params.domain || new URL(page.url()).hostname,
                path: params.path || "/",
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
