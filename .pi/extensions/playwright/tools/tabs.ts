import { registerTool } from "../../../lib/pi-tool-registration.js";
/**
 * Tab Management Tools
 *
 * browser_new_page, browser_close_page, browser_switch_tab, browser_list_tabs
 *
 * Translated from MCP: tabs.ts
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BrowserManager } from "../browser.js";
import type { PlaywrightConfig } from "../types.js";

export function registerTabsTools(pi: ExtensionAPI, _config: PlaywrightConfig) {
  const browser = BrowserManager.getBrowser();

  // ==========================================================================
  // playwright_new_page
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_new_page",
    label: "New Page",
    description:
      "Open a new browser page (tab). Optionally navigate to a URL immediately. Returns the new page ID for switching.",
    promptSnippet: "Open a new browser page/tab",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "URL to navigate the new page to" })),
    }),
    async execute(_toolCallId, params) {
      const result = await browser.newPage(params.url);

      return {
        content: [
          {
            type: "text",
            text: `New page opened: pageId=${result.pageId}${result.url ? ` (${result.url})` : ""}`,
          },
        ],
        details: result,
      };
    },
  });

  // ==========================================================================
  // playwright_close_page
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_close_page",
    label: "Close Page",
    description: "Close a browser page by its page ID. Cannot close the last remaining page.",
    promptSnippet: "Close a browser page/tab",
    parameters: Type.Object({
      pageId: Type.String({
        description: "Page ID to close (from playwright_new_page or playwright_list_tabs)",
      }),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await browser.closePage(params.pageId);
        return {
          content: [
            {
              type: "text",
              text: `Page closed. ${result.remainingPages} page(s) remaining.`,
            },
          ],
          details: result,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: err instanceof Error ? err.message : String(err),
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_switch_tab
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_switch_tab",
    label: "Switch Tab",
    description:
      "Switch to a different browser page/tab by its page ID. Use playwright_list_tabs to see available tabs.",
    promptSnippet: "Switch to a different browser tab",
    parameters: Type.Object({
      pageId: Type.String({
        description: "Page ID to switch to (from playwright_list_tabs)",
      }),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = browser.switchTab(params.pageId);
        return {
          content: [
            {
              type: "text",
              text: `Switched to page ${result.pageId}: ${result.url}`,
            },
          ],
          details: result,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: err instanceof Error ? err.message : String(err),
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_list_tabs
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_list_tabs",
    label: "List Tabs",
    description:
      "List all open browser pages/tabs with their IDs, URLs, and titles. The active tab is highlighted.",
    promptSnippet: "List all open browser tabs",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const tabs = await browser.listTabs();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(tabs, null, 2),
          },
        ],
        details: tabs,
      };
    },
  });
}
