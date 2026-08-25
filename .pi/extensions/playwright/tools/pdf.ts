import { registerTool } from "../../../lib/pi-tool-registration.js";
/**
 * PDF & Unsafe Code Tools
 *
 * browser_pdf, browser_run_code_unsafe
 *
 * Translated from MCP: pdf.ts, runCode.ts
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { BrowserManager } from "../browser.js";
import type { PlaywrightConfig } from "../types.js";

type UnsafePlaywrightRunner = (page: unknown, browser: unknown, context: unknown) => unknown;

function isUnsafePlaywrightRunner(value: unknown): value is UnsafePlaywrightRunner {
  return typeof value === "function";
}

export function registerPdfTools(pi: ExtensionAPI, config: PlaywrightConfig) {
  const browser = BrowserManager.getBrowser();

  // ==========================================================================
  // playwright_pdf
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_pdf",
    label: "Save as PDF",
    description: "Save the current page as a PDF file. Only works in Chromium headless mode.",
    promptSnippet: "Save page as PDF",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "Output file path (default: auto-generated)" })
      ),
      format: Type.Optional(
        Type.Union([
          Type.Literal("Letter"),
          Type.Literal("Legal"),
          Type.Literal("Tabloid"),
          Type.Literal("A4"),
          Type.Literal("A3"),
          Type.Literal("A5"),
        ])
      ),
      printBackground: Type.Optional(
        Type.Boolean({ description: "Print background graphics (default: false)" })
      ),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();

      const outputDir = params.path ? dirname(params.path) : config.outputDir;
      if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

      const path = params.path || `${outputDir}/page-${Date.now()}.pdf`;

      await page.pdf({
        path,
        format: params.format || "A4",
        printBackground: params.printBackground ?? false,
      });

      const stats = statSync(path);

      return {
        content: [
          {
            type: "text",
            text: `PDF saved: ${path} (${(stats.size / 1024).toFixed(1)} KB)`,
          },
        ],
        details: { filePath: path, fileSizeBytes: stats.size },
      };
    },
  });

  // ==========================================================================
  // playwright_run_code_unsafe
  // ⚠️ Executes arbitrary Playwright Node.js code — RCE-equivalent
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_run_code_unsafe",
    label: "⚠️ Run Unsafe Code",
    description:
      "⚠️ UNSAFE: Execute arbitrary Playwright Node.js code with full system access. " +
      "The code can access page, browser, context objects and any Node.js API. " +
      "Use ONLY as a last resort when standard tools are insufficient. " +
      "Requires PLAYWRIGHT_ALLOW_UNSAFE=true.",
    promptSnippet: "⚠️ Run arbitrary Playwright code (unsafe)",
    parameters: Type.Object({
      code: Type.String({
        description:
          "JavaScript code to execute. Receives (page, browser, context). Example: await page.evaluate(() => document.cookie)",
      }),
    }),
    async execute(_toolCallId, params) {
      if (!config.allowUnsafe) {
        return {
          content: [
            {
              type: "text",
              text: "❌ UNSAFE CODE BLOCKED. Set PLAYWRIGHT_ALLOW_UNSAFE=true to enable this tool.",
            },
          ],
          isError: true,
        };
      }

      const page = await browser.getPage();

      try {
        // Create a function from the explicitly authorized code string. Treat
        // both the dynamic callable and its result as unknown at this boundary.
        const candidate: unknown = new Function("page", "browser", "context", params.code);
        if (!isUnsafePlaywrightRunner(candidate)) {
          throw new TypeError("Unsafe Playwright code did not compile to a callable function");
        }
        const result: unknown = await candidate(page, browser.getRawBrowser(), page.context());

        return {
          content: [
            {
              type: "text",
              text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
            },
          ],
          details: { result },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Unsafe code error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
