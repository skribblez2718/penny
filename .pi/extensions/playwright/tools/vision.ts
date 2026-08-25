import { registerTool } from "../../../lib/pi-tool-registration.js";
/**
 * Vision Tools — Mouse Control & DevTools
 *
 * browser_mouse_move_xy, browser_mouse_click_xy, browser_mouse_drag_xy,
 * browser_mouse_wheel, browser_highlight, browser_hide_highlight,
 * browser_start_tracing, browser_stop_tracing
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BrowserManager } from "../browser.js";
import type { PlaywrightConfig } from "../types.js";

export function registerVisionDevtoolsTools(pi: ExtensionAPI, _config: PlaywrightConfig) {
  const browser = BrowserManager.getBrowser();

  // ==========================================================================
  // playwright_mouse_move_xy
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_mouse_move_xy",
    label: "Mouse Move",
    description:
      "Move the mouse to viewport-relative X,Y coordinates. Prefer selector-based interaction after playwright_snapshot when an element can be targeted directly.",
    promptSnippet: "Move mouse to X,Y coordinates",
    parameters: Type.Object({
      x: Type.Number({ description: "X coordinate" }),
      y: Type.Number({ description: "Y coordinate" }),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      await page.mouse.move(params.x, params.y);
      return {
        content: [
          {
            type: "text",
            text: `Mouse moved to (${params.x}, ${params.y})`,
          },
        ],
        details: { x: params.x, y: params.y },
      };
    },
  });

  // ==========================================================================
  // playwright_mouse_click_xy
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_mouse_click_xy",
    label: "Mouse Click XY",
    description:
      "Click at viewport-relative X,Y coordinates. Use only when the target cannot be addressed reliably with a selector-based click.",
    promptSnippet: "Click at X,Y coordinates",
    parameters: Type.Object({
      x: Type.Number({ description: "X coordinate" }),
      y: Type.Number({ description: "Y coordinate" }),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      await page.mouse.click(params.x, params.y);
      return {
        content: [
          {
            type: "text",
            text: `Clicked at (${params.x}, ${params.y})`,
          },
        ],
        details: { x: params.x, y: params.y },
      };
    },
  });

  // ==========================================================================
  // playwright_mouse_drag_xy
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_mouse_drag_xy",
    label: "Mouse Drag XY",
    description:
      "Drag between two viewport-relative coordinate pairs for interactions that cannot be targeted by source and destination selectors.",
    promptSnippet: "Drag mouse from X1,Y1 to X2,Y2",
    parameters: Type.Object({
      fromX: Type.Number({ description: "Start X" }),
      fromY: Type.Number({ description: "Start Y" }),
      toX: Type.Number({ description: "End X" }),
      toY: Type.Number({ description: "End Y" }),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      await page.mouse.move(params.fromX, params.fromY);
      await page.mouse.down();
      await page.mouse.move(params.toX, params.toY, { steps: 10 });
      await page.mouse.up();
      return {
        content: [
          {
            type: "text",
            text: `Dragged (${params.fromX},${params.fromY}) → (${params.toX},${params.toY})`,
          },
        ],
        details: params,
      };
    },
  });

  // ==========================================================================
  // playwright_mouse_wheel
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_mouse_wheel",
    label: "Mouse Wheel",
    description:
      "Scroll the page by X/Y deltas. Positive deltaY scrolls down and negative deltaY scrolls up.",
    promptSnippet: "Scroll page by delta",
    parameters: Type.Object({
      deltaX: Type.Optional(Type.Number({ description: "Horizontal scroll (default: 0)" })),
      deltaY: Type.Optional(Type.Number({ description: "Vertical scroll (default: 0)" })),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      await page.mouse.wheel(params.deltaX ?? 0, params.deltaY ?? 0);
      return {
        content: [
          {
            type: "text",
            text: `Scrolled (dx=${params.deltaX ?? 0}, dy=${params.deltaY ?? 0})`,
          },
        ],
        details: params,
      };
    },
  });

  // ==========================================================================
  // playwright_highlight
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_highlight",
    label: "Highlight Element",
    description: "Highlight an element on the page with a visible overlay (useful for debugging).",
    promptSnippet: "Highlight an element visually",
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector for the element to highlight",
      }),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const selector = params.selector;

      try {
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) {
            throw new Error(`Element not found: ${sel}`);
          }
          el.style.outline = "3px dashed red";
          el.style.outlineOffset = "2px";
        }, selector);

        return {
          content: [
            {
              type: "text",
              text: `Highlighted ${selector}`,
            },
          ],
          details: { selector, highlighted: true },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Highlight failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_hide_highlight
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_hide_highlight",
    label: "Hide Highlight",
    description: "Remove all highlight overlays from the page.",
    promptSnippet: "Remove element highlights",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const page = await browser.getPage();
      await page.evaluate(() => {
        document.querySelectorAll("*").forEach((el) => {
          if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return;
          if (el.style.outline.includes("dashed red")) {
            el.style.outline = "";
            el.style.outlineOffset = "";
          }
        });
      });

      return {
        content: [
          {
            type: "text",
            text: "All highlights removed",
          },
        ],
        details: { cleared: true },
      };
    },
  });

  // ==========================================================================
  // playwright_start_tracing
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_start_tracing",
    label: "Start Tracing",
    description:
      "Start recording a trace of browser activity for debugging. Call playwright_stop_tracing afterward to save the trace file.",
    promptSnippet: "Start browser trace recording",
    parameters: Type.Object({
      screenshots: Type.Optional(
        Type.Boolean({ description: "Capture screenshots during trace (default: true)" })
      ),
      snapshots: Type.Optional(
        Type.Boolean({ description: "Capture DOM snapshots (default: true)" })
      ),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      await page.context().tracing.start({
        screenshots: params.screenshots ?? true,
        snapshots: params.snapshots ?? true,
      });

      return {
        content: [
          {
            type: "text",
            text: "Trace recording started",
          },
        ],
        details: { recording: true },
      };
    },
  });

  // ==========================================================================
  // playwright_stop_tracing
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_stop_tracing",
    label: "Stop Tracing",
    description:
      "Stop a trace started by playwright_start_tracing and save it for Playwright Trace Viewer.",
    promptSnippet: "Stop trace recording and save",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description: "Output path for trace file (default: auto-generated)",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const path = params.path || `/tmp/playwright-output/trace-${Date.now()}.zip`;

      await page.context().tracing.stop({ path });

      return {
        content: [
          {
            type: "text",
            text: `Trace saved: ${path}`,
          },
        ],
        details: { filePath: path, recording: false },
      };
    },
  });
}
