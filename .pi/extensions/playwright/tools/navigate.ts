/**
 * Navigation Tools
 *
 * browser_navigate, browser_navigate_back, browser_navigate_forward, browser_reload
 *
 * Translated from MCP: /tmp/playwright/packages/playwright-core/src/tools/backend/navigate.ts
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BrowserManager } from "../browser.js";
import type { PlaywrightConfig, NavigateResult } from "../types.js";

export function registerNavigationTools(pi: ExtensionAPI, _config: PlaywrightConfig) {
  const browser = BrowserManager.getBrowser();

  // ==========================================================================
  // browser_navigate
  // ==========================================================================
  pi.registerTool({
    name: "playwright_navigate",
    label: "Navigate Browser",
    description:
      "Navigate the browser to a URL. Returns page metadata and an accessibility snapshot of the page after navigation. Use this to open a new page or navigate the current page to a different URL.",
    promptSnippet: "Navigate browser to a URL",
    promptGuidelines: [
      "Use playwright_navigate to open a web page or navigate to a new URL.",
      "After navigating, the page's accessibility snapshot is automatically included in the result.",
      "URLs without a protocol (http:// or https://) will automatically use https://.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The URL to navigate to" }),
    }),
    async execute(_toolCallId, params) {
      const result: NavigateResult = await browser.navigate(params.url as string);

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
  pi.registerTool({
    name: "playwright_navigate_back",
    label: "Go Back",
    description:
      "Go back to the previous page in browser history. Returns the page URL and an accessibility snapshot.",
    promptSnippet: "Go back to the previous page",
    promptGuidelines: [
      "Use playwright_navigate_back to return to the previous page.",
      "If there is no previous page in history, the tool returns an error.",
    ],
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
  pi.registerTool({
    name: "playwright_navigate_forward",
    label: "Go Forward",
    description:
      "Go forward to the next page in browser history. Returns the page URL and an accessibility snapshot.",
    promptSnippet: "Go forward to the next page",
    promptGuidelines: [
      "Use playwright_navigate_forward after using playwright_navigate_back to return to the page you were on.",
      "If there is no forward page, the tool returns an error.",
    ],
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
  pi.registerTool({
    name: "playwright_reload",
    label: "Reload Page",
    description:
      "Reload the current page. Returns the page URL and an accessibility snapshot after reload.",
    promptSnippet: "Reload the current page",
    promptGuidelines: [
      "Use playwright_reload to refresh the current page.",
      "Useful after making changes that require a page refresh to take effect.",
    ],
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
  pi.registerTool({
    name: "playwright_get_current_url",
    label: "Get Current URL",
    description: "Get the URL of the current active page. No side effects.",
    promptSnippet: "Get the current browser URL",
    promptGuidelines: [
      "Use playwright_get_current_url to check what page the browser is currently on.",
    ],
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
  pi.registerTool({
    name: "playwright_get_title",
    label: "Get Page Title",
    description: "Get the title of the current active page. No side effects.",
    promptSnippet: "Get the current page title",
    promptGuidelines: ["Use playwright_get_title to check the title of the current page."],
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
