import { registerTool } from "../../../lib/pi-tool-registration.js";
/**
 * Navigation Tools
 *
 * browser_navigate, browser_navigate_back, browser_navigate_forward, browser_reload
 *
 * Translated from MCP: /tmp/playwright/packages/playwright-core/src/tools/backend/navigate.ts
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BrowserManager } from "../browser.js";
import type { PlaywrightConfig, NavigateResult } from "../types.js";

export function registerNavigationTools(pi: ExtensionAPI, _config: PlaywrightConfig) {
  const browser = BrowserManager.getBrowser();

  // ==========================================================================
  // browser_navigate
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_navigate",
    label: "Navigate Browser",
    description:
      "Navigate the browser to a URL. Returns page metadata and an accessibility snapshot of the page after navigation. Use this to open a new page or navigate the current page to a different URL.",
    promptSnippet: "Navigate browser to a URL",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to navigate to" }),
    }),
    async execute(_toolCallId, params) {
      const result: NavigateResult = await browser.navigate(params.url);

      // Take accessibility snapshot after navigation (equivalent to response.setIncludeSnapshot())
      const snapshot = await browser.snapshot();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                navigation: result,
                snapshot: snapshot.tree,
                snapshotError: snapshot.error,
              },
              null,
              2
            ),
          },
        ],
        details: { result, snapshot: snapshot.tree },
      };
    },
  });

  // ==========================================================================
  // browser_navigate_back
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_navigate_back",
    label: "Go Back",
    description:
      "Go back to the previous page in browser history. Returns the page URL and an accessibility snapshot.",
    promptSnippet: "Go back to the previous page",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const page = await browser.getPage();
      try {
        await page.goBack({ timeout: 30000, waitUntil: "domcontentloaded" });
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Cannot go back — no previous page in history. ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }

      const snapshot = await browser.snapshot();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                url: page.url(),
                title: await page.title().catch(() => ""),
                snapshot: snapshot.tree,
              },
              null,
              2
            ),
          },
        ],
        details: { url: page.url() },
      };
    },
  });

  // ==========================================================================
  // browser_navigate_forward
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_navigate_forward",
    label: "Go Forward",
    description:
      "Go forward to the next page in browser history. Returns the page URL and an accessibility snapshot.",
    promptSnippet: "Go forward to the next page",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const page = await browser.getPage();
      try {
        await page.goForward({ timeout: 30000, waitUntil: "domcontentloaded" });
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Cannot go forward — no forward page in history. ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }

      const snapshot = await browser.snapshot();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                url: page.url(),
                title: await page.title().catch(() => ""),
                snapshot: snapshot.tree,
              },
              null,
              2
            ),
          },
        ],
        details: { url: page.url() },
      };
    },
  });

  // ==========================================================================
  // browser_reload
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_reload",
    label: "Reload Page",
    description:
      "Reload the current page. Returns the page URL and an accessibility snapshot after reload.",
    promptSnippet: "Reload the current page",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const page = await browser.getPage();
      await page.reload({ timeout: 30000, waitUntil: "domcontentloaded" });

      const snapshot = await browser.snapshot();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                url: page.url(),
                title: await page.title().catch(() => ""),
                snapshot: snapshot.tree,
              },
              null,
              2
            ),
          },
        ],
        details: { url: page.url() },
      };
    },
  });

  // ==========================================================================
  // browser_get_current_url
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_get_current_url",
    label: "Get Current URL",
    description: "Get the URL of the current active page. No side effects.",
    promptSnippet: "Get the current browser URL",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const page = await browser.getPage();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ url: page.url() }, null, 2),
          },
        ],
        details: { url: page.url() },
      };
    },
  });

  // ==========================================================================
  // browser_get_title
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_get_title",
    label: "Get Page Title",
    description: "Get the title of the current active page. No side effects.",
    promptSnippet: "Get the current page title",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const page = await browser.getPage();
      const title = await page.title().catch(() => "");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ title }, null, 2),
          },
        ],
        details: { title },
      };
    },
  });
}
