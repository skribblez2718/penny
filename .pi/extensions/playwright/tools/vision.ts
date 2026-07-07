/**
 * Vision Tools — Mouse Control & DevTools
 *
 * browser_mouse_move_xy, browser_mouse_click_xy, browser_mouse_drag_xy,
 * browser_mouse_wheel, browser_highlight, browser_hide_highlight,
 * browser_start_tracing, browser_stop_tracing
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BrowserManager } from "../browser.js";
import type { PlaywrightConfig } from "../types.js";

export function registerVisionDevtoolsTools(pi: ExtensionAPI, _config: PlaywrightConfig) {
  const browser = BrowserManager.getBrowser();

  // ==========================================================================
  // playwright_mouse_move_xy
  // ==========================================================================
  pi.registerTool({
    name: "playwright_mouse_move_xy",
    label: "Mouse Move",
    description: "Move the mouse to specific X,Y coordinates on the page.",
    promptSnippet: "Move mouse to X,Y coordinates",
    promptGuidelines: [
      "Coordinates are relative to the viewport (0,0 = top-left).",
      "Use after playwright_snapshot to understand element positions.",
    ],
    parameters: Type.Object({
      x: Type.Number({ description: "X coordinate" }),
      y: Type.Number({ description: "Y coordinate" }),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      await page.mouse.move(params.x as number, params.y as number);
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
  pi.registerTool({
    name: "playwright_mouse_click_xy",
    label: "Mouse Click XY",
    description: "Click at specific X,Y coordinates.",
    promptSnippet: "Click at X,Y coordinates",
    promptGuidelines: [
      "Use when elements cannot be targeted by CSS selector.",
      "Click is performed at the viewport-relative coordinates.",
    ],
    parameters: Type.Object({
      x: Type.Number({ description: "X coordinate" }),
      y: Type.Number({ description: "Y coordinate" }),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      await page.mouse.click(params.x as number, params.y as number);
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
  pi.registerTool({
    name: "playwright_mouse_drag_xy",
    label: "Mouse Drag XY",
    description: "Drag from one set of coordinates to another.",
    promptSnippet: "Drag mouse from X1,Y1 to X2,Y2",
    promptGuidelines: ["Use for testing drag-based interactions at the coordinate level."],
    parameters: Type.Object({
      fromX: Type.Number({ description: "Start X" }),
      fromY: Type.Number({ description: "Start Y" }),
      toX: Type.Number({ description: "End X" }),
      toY: Type.Number({ description: "End Y" }),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      await page.mouse.move(params.fromX as number, params.fromY as number);
      await page.mouse.down();
      await page.mouse.move(params.toX as number, params.toY as number, { steps: 10 });
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
  pi.registerTool({
    name: "playwright_mouse_wheel",
    label: "Mouse Wheel",
    description: "Scroll the page by a delta X,Y amount.",
    promptSnippet: "Scroll page by delta",
    promptGuidelines: ["Positive deltaY scrolls down; negative scrolls up."],
    parameters: Type.Object({
      deltaX: Type.Optional(Type.Number({ description: "Horizontal scroll (default: 0)" })),
      deltaY: Type.Optional(Type.Number({ description: "Vertical scroll (default: 0)" })),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      await page.mouse.wheel((params.deltaX as number) ?? 0, (params.deltaY as number) ?? 0);
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
  pi.registerTool({
    name: "playwright_highlight",
    label: "Highlight Element",
    description: "Highlight an element on the page with a visible overlay (useful for debugging).",
    promptSnippet: "Highlight an element visually",
    promptGuidelines: [
      "Use playwright_highlight to visually mark an element for debugging.",
      "The highlight is a red dashed border overlay.",
      "Use playwright_hide_highlight to remove it.",
    ],
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector for the element to highlight",
      }),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const selector = params.selector as string;

      try {
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) throw new Error(`Element not found: ${sel}`);
          (el as HTMLElement).style.outline = "3px dashed red";
          (el as HTMLElement).style.outlineOffset = "2px";
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
  pi.registerTool({
    name: "playwright_hide_highlight",
    label: "Hide Highlight",
    description: "Remove all highlight overlays from the page.",
    promptSnippet: "Remove element highlights",
    promptGuidelines: ["Use playwright_hide_highlight to clean up visual debugging markers."],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const page = await browser.getPage();
      await page.evaluate(() => {
        document.querySelectorAll("*").forEach((el) => {
          const htmlEl = el as HTMLElement;
          if (htmlEl.style.outline.includes("dashed red")) {
            htmlEl.style.outline = "";
            htmlEl.style.outlineOffset = "";
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
  pi.registerTool({
    name: "playwright_start_tracing",
    label: "Start Tracing",
    description: "Start recording a trace of browser activity (screenshots, network, etc.).",
    promptSnippet: "Start browser trace recording",
    promptGuidelines: [
      "Use playwright_start_tracing to record browser activity for debugging.",
      "Call playwright_stop_tracing to save the trace file.",
    ],
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
        screenshots: (params.screenshots as boolean) ?? true,
        snapshots: (params.snapshots as boolean) ?? true,
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
  pi.registerTool({
    name: "playwright_stop_tracing",
    label: "Stop Tracing",
    description: "Stop trace recording and save to file.",
    promptSnippet: "Stop trace recording and save",
    promptGuidelines: [
      "Use after playwright_start_tracing to save the trace.",
      "Trace files can be opened in Playwright Trace Viewer.",
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description: "Output path for trace file (default: auto-generated)",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const path = (params.path as string) || `/tmp/playwright-output/trace-${Date.now()}.zip`;

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
