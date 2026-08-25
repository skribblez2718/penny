import { registerTool } from "../../../lib/pi-tool-registration.js";
/**
 * Interaction Tools — Click, Double-click, Hover, Drag
 *
 * Translated from MCP: snapshot.ts (click, drag, hover)
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BrowserManager } from "../browser.js";
import type { PlaywrightConfig } from "../types.js";

export function registerClickTools(pi: ExtensionAPI, _config: PlaywrightConfig) {
  const browser = BrowserManager.getBrowser();

  // ==========================================================================
  // playwright_click
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_click",
    label: "Click Element",
    description:
      "Click an element on the page by CSS selector or accessibility reference. Use playwright_snapshot first to find element selectors.",
    promptSnippet: "Click an element on the page",
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector for the element to click",
      }),
      button: Type.Optional(
        Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], {
          description: "Mouse button (default: left)",
        })
      ),
      modifiers: Type.Optional(
        Type.Array(
          Type.Union([
            Type.Literal("Alt"),
            Type.Literal("Control"),
            Type.Literal("Meta"),
            Type.Literal("Shift"),
          ]),
          { description: "Modifier keys to hold during click" }
        )
      ),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 5000)" })),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const selector = params.selector;
      const timeout = params.timeout ?? 5000;

      try {
        const locator = page.locator(selector).first();
        await locator.click({
          button: params.button ?? "left",
          modifiers: params.modifiers,
          timeout,
        });

        // Get element info for confirmation
        const tagName = await locator.evaluate((el) => el.tagName.toLowerCase());
        const text = await locator.textContent().catch(() => "");

        return {
          content: [
            {
              type: "text",
              text: `Clicked: <${tagName}>${selector}${text ? ` "${text.trim().slice(0, 80)}"` : ""}`,
            },
          ],
          details: {
            clicked: true,
            selector,
            elementTag: tagName,
            elementText: text?.trim().slice(0, 100),
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Click failed: ${err instanceof Error ? err.message : String(err)}\n\nTry playwright_snapshot first to verify the element exists and is visible.`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_double_click
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_double_click",
    label: "Double-Click Element",
    description:
      "Double-click an element on the page by CSS selector. Use playwright_snapshot first to locate the element; choose this instead of playwright_click only when the interface requires a double-click action.",
    promptSnippet: "Double-click an element on the page",
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector for the element to double-click",
      }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 5000)" })),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const selector = params.selector;

      try {
        const locator = page.locator(selector).first();
        await locator.dblclick({
          timeout: params.timeout ?? 5000,
        });

        const tagName = await locator.evaluate((el) => el.tagName.toLowerCase());

        return {
          content: [
            {
              type: "text",
              text: `Double-clicked: <${tagName}>${selector}`,
            },
          ],
          details: { clicked: true, selector, elementTag: tagName },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Double-click failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_hover
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_hover",
    label: "Hover Element",
    description:
      "Hover the mouse over an element. Use playwright_snapshot first to locate it, then snapshot again when you need to inspect tooltips, dropdowns, or other hover-revealed content.",
    promptSnippet: "Hover over an element",
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector for the element to hover over",
      }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 5000)" })),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const selector = params.selector;

      try {
        const locator = page.locator(selector).first();
        await locator.hover({
          timeout: params.timeout ?? 5000,
        });

        const tagName = await locator.evaluate((el) => el.tagName.toLowerCase());

        return {
          content: [
            {
              type: "text",
              text: `Hovered: <${tagName}>${selector}`,
            },
          ],
          details: { hovered: true, selector, elementTag: tagName },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Hover failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_drag
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_drag",
    label: "Drag Element",
    description:
      "Drag an element from one location to another on the page. Use playwright_snapshot first to locate the source and target selectors.",
    promptSnippet: "Drag an element to another location",
    parameters: Type.Object({
      sourceSelector: Type.String({
        description: "CSS selector for the element to drag",
      }),
      targetSelector: Type.String({
        description: "CSS selector for where to drop the element",
      }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 5000)" })),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const source = params.sourceSelector;
      const target = params.targetSelector;

      try {
        await page
          .locator(source)
          .first()
          .dragTo(page.locator(target).first(), {
            timeout: params.timeout ?? 5000,
          });

        return {
          content: [
            {
              type: "text",
              text: `Dragged ${source} → ${target}`,
            },
          ],
          details: { dragged: true, source, target },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Drag failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
