/**
 * Core Tools
 *
 * browser_snapshot, browser_screenshot, browser_close, browser_resize
 *
 * Translated from MCP: snapshot.ts, screenshot.ts, common.ts
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BrowserManager } from "../browser.js";
import type { PlaywrightConfig, ScreenshotResult, SnapshotNode } from "../types.js";

export function registerCoreTools(pi: ExtensionAPI, config: PlaywrightConfig) {
  const browser = BrowserManager.getBrowser();

  // ==========================================================================
  // browser_snapshot
  // ==========================================================================
  pi.registerTool({
    name: "playwright_snapshot",
    label: "Page Snapshot",
    description:
      "Capture the accessibility snapshot of the current page. This is the primary way to understand page structure — it returns a semantic tree of roles, names, and states that is better for LLM analysis than raw HTML or screenshots.",
    promptSnippet: "Capture accessibility snapshot of the current page",
    promptGuidelines: [
      "Use playwright_snapshot to understand page structure before interacting with elements.",
      "The snapshot shows semantic roles (button, link, textbox, etc.) with their names and states.",
      "Snapshots are more compact and informative than raw HTML or DOM.",
      "Use snapshot results to find element selectors for click, type, and other interaction tools.",
    ],
    parameters: Type.Object({
      depth: Type.Optional(
        Type.Number({
          description: "Limit the depth of the snapshot tree (default: unlimited)",
          minimum: 1,
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const snapshot = await browser.snapshot();

      let tree = snapshot.tree;
      if (params.depth && tree) {
        tree = limitDepth(tree, params.depth as number);
      }

      const nodeCount = countNodes(tree);
      const truncated = nodeCount > 500;
      if (truncated) {
        tree = truncateTree(tree, 500);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                tree,
                nodeCount,
                truncated,
                snapshotError: snapshot.error,
              },
              null,
              2
            ),
          },
        ],
        details: { tree, nodeCount, truncated },
      };
    },
  });

  // ==========================================================================
  // browser_screenshot
  // ==========================================================================
  pi.registerTool({
    name: "playwright_screenshot",
    label: "Take Screenshot",
    description:
      "Take a screenshot of the current page or a specific element. Saves the image to a file and returns the file path. Use this for visual inspection — for structural analysis, prefer playwright_snapshot.",
    promptSnippet: "Take a screenshot of the current page",
    promptGuidelines: [
      "Use playwright_screenshot for visual inspection of the page.",
      "For structural analysis, use playwright_snapshot instead — it's more informative for LLMs.",
      "Screenshots are saved to the configured output directory.",
      "You can screenshot the full page (fullPage: true) or just the visible viewport.",
    ],
    parameters: Type.Object({
      selector: Type.Optional(
        Type.String({ description: "CSS selector to screenshot a specific element" })
      ),
      fullPage: Type.Optional(
        Type.Boolean({
          description: "Capture the full scrollable page instead of just the viewport",
        })
      ),
      type: Type.Optional(
        Type.Union([Type.Literal("png"), Type.Literal("jpeg")], {
          description: "Image format (default: png)",
        })
      ),
      quality: Type.Optional(
        Type.Number({
          description: "JPEG quality 0-100 (only for type: jpeg)",
          minimum: 0,
          maximum: 100,
        })
      ),
      path: Type.Optional(
        Type.String({ description: "File path to save the screenshot to" })
      ),
    }),
    async execute(_toolCallId, params) {
      const result: ScreenshotResult = await browser.screenshot({
        selector: params.selector as string | undefined,
        fullPage: params.fullPage as boolean | undefined,
        type: (params.type as "png" | "jpeg") ?? "png",
        quality: params.quality as number | undefined,
        path: params.path as string | undefined,
      });

      const summary = `Screenshot saved: ${result.filePath} (${result.width}x${result.height}, ${formatBytes(result.fileSizeBytes)}, ${result.mimeType})`;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...result, summary }, null, 2),
          },
        ],
        details: result,
      };
    },
  });

  // ==========================================================================
  // browser_close
  // ==========================================================================
  pi.registerTool({
    name: "playwright_close",
    label: "Close Browser",
    description:
      "Close the current browser page. If it was the last page, closes the browser entirely.",
    promptSnippet: "Close the current browser page",
    promptGuidelines: [
      "Use playwright_close when you're done with the current page.",
      "If there are multiple pages open, the next page becomes active.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      await browser.close();

      const tabs = await browser.listTabs();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                closed: true,
                remainingTabs: tabs.tabs.length,
                tabs: tabs.tabs,
              },
              null,
              2
            ),
          },
        ],
        details: { closed: true, remainingTabs: tabs.tabs.length },
      };
    },
  });

  // ==========================================================================
  // browser_resize
  // ==========================================================================
  pi.registerTool({
    name: "playwright_resize",
    label: "Resize Browser",
    description:
      "Resize the browser viewport to specific dimensions. Useful for responsive testing or ensuring consistent screenshot sizes.",
    promptSnippet: "Resize the browser viewport",
    promptGuidelines: [
      "Use playwright_resize to change the browser window size.",
      "Useful for testing responsive layouts or mobile viewports.",
    ],
    parameters: Type.Object({
      width: Type.Number({ description: "Viewport width in pixels", minimum: 1 }),
      height: Type.Number({ description: "Viewport height in pixels", minimum: 1 }),
    }),
    async execute(_toolCallId, params) {
      await browser.resize(params.width as number, params.height as number);

      return {
        content: [
          {
            type: "text",
            text: `Viewport resized to ${params.width}x${params.height}`,
          },
        ],
        details: { width: params.width, height: params.height },
      };
    },
  });
}

// ============================================================================
// Helpers
// ============================================================================

function countNodes(node: SnapshotNode | null | undefined): number {
  if (!node) return 0;
  let count = 1;
  if (node.children) {
    for (const child of node.children) {
      count += countNodes(child);
    }
  }
  return count;
}

function limitDepth(node: SnapshotNode, maxDepth: number, currentDepth = 0): SnapshotNode | null {
  if (currentDepth >= maxDepth) return null;
  const children = node.children
    ?.map((c) => limitDepth(c, maxDepth, currentDepth + 1))
    .filter((c): c is SnapshotNode => c !== null);
  return { ...node, children: children?.length ? children : undefined };
}

function truncateTree(node: SnapshotNode, maxNodes: number): SnapshotNode | null {
  let remaining = maxNodes;
  function walk(n: SnapshotNode): SnapshotNode | null {
    if (remaining <= 0) return null;
    remaining--;
    const children = n.children
      ?.map(walk)
      .filter((c): c is SnapshotNode => c !== null);
    return { ...n, children: children?.length ? children : undefined };
  }
  return walk(node);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
