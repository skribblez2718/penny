/**
 * Evaluate & Wait Tools
 *
 * browser_evaluate, browser_wait_for
 *
 * Translated from MCP: evaluate.ts, wait.ts
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BrowserManager } from "../browser.js";
import type { PlaywrightConfig } from "../types.js";

export function registerEvaluateTools(pi: ExtensionAPI, _config: PlaywrightConfig) {
  const browser = BrowserManager.getBrowser();

  // ==========================================================================
  // playwright_evaluate
  // ==========================================================================
  pi.registerTool({
    name: "playwright_evaluate",
    label: "Evaluate JavaScript",
    description:
      "Execute JavaScript in the browser page context. Returns the result. Use for data extraction, DOM inspection, and interacting with page JavaScript. Runs in browser sandbox (no Node.js access).",
    promptSnippet: "Execute JavaScript in the page",
    promptGuidelines: [
      "Use playwright_evaluate to extract data, inspect the DOM, or interact with page JavaScript.",
      "The expression runs in the browser context — use document, window, etc.",
      "For extracting element data: document.querySelector('...').textContent",
      "For structured data: JSON.parse(document.querySelector('#data').textContent)",
      "Results are JSON-serialized. Functions and DOM elements become 'undefined'.",
      "Security: browser sandbox only. Cannot access Node.js APIs or filesystem.",
    ],
    parameters: Type.Object({
      expression: Type.String({
        description:
          "JavaScript expression to evaluate. Example: 'document.title' or 'Array.from(document.querySelectorAll(\"a\")).map(a => ({href: a.href, text: a.textContent.trim()}))'",
      }),
      selector: Type.Optional(
        Type.String({
          description:
            "CSS selector. If provided, expression receives the element as first argument.",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const expression = params.expression as string;
      const selector = params.selector as string | undefined;

      try {
        let result: unknown;
        if (selector) {
          const locator = page.locator(selector).first();
          result = await locator.evaluate((el, expr) => {
            const fn = eval(`(${expr})`);
            return typeof fn === "function" ? fn(el) : fn;
          }, expression);
        } else {
          result = await page.evaluate((expr) => {
            const fn = eval(`(${expr})`);
            return typeof fn === "function" ? fn() : fn;
          }, expression);
        }

        const resultType = typeof result;
        const serialized = resultType !== "function" && resultType !== "undefined";

        return {
          content: [
            {
              type: "text",
              text: serialized ? JSON.stringify(result, null, 2) : `[${resultType}]`,
            },
          ],
          details: { result, type: resultType, serializable: serialized },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Evaluate error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_wait_for
  // ==========================================================================
  pi.registerTool({
    name: "playwright_wait_for",
    label: "Wait For",
    description:
      "Wait for a condition on the page: an element to appear/disappear, text to appear, or a specified amount of time.",
    promptSnippet: "Wait for element or time on the page",
    promptGuidelines: [
      "Use playwright_wait_for to pause until the page is ready for interaction.",
      "Wait for elements to appear after navigation or dynamic loading.",
      "Use text mode to wait for specific content to appear/disappear.",
      "Use time mode for simple delays (use sparingly — prefer element-based waiting).",
    ],
    parameters: Type.Object({
      mode: Type.Union([Type.Literal("selector"), Type.Literal("text"), Type.Literal("time")], {
        description: "Wait mode",
      }),
      selector: Type.Optional(
        Type.String({ description: "CSS selector to wait for (mode: selector)" })
      ),
      state: Type.Optional(
        Type.Union([
          Type.Literal("visible"),
          Type.Literal("hidden"),
          Type.Literal("attached"),
          Type.Literal("detached"),
        ])
      ),
      text: Type.Optional(
        Type.String({ description: "Text to wait for to appear or disappear (mode: text)" })
      ),
      textGone: Type.Optional(
        Type.Boolean({
          description: "Wait for text to disappear (mode: text, default: false)",
        })
      ),
      ms: Type.Optional(
        Type.Number({
          description: "Milliseconds to wait (mode: time, max: 60000)",
          minimum: 0,
          maximum: 60000,
        })
      ),
      timeout: Type.Optional(
        Type.Number({ description: "Maximum wait timeout in ms (default: 30000)" })
      ),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const mode = params.mode as string;
      const timeout = (params.timeout as number) ?? 30000;
      const start = Date.now();

      try {
        if (mode === "time") {
          const ms = (params.ms as number) ?? 1000;
          await page.waitForTimeout(ms);
          return {
            content: [{ type: "text", text: `Waited ${ms}ms` }],
            details: { waitedMs: ms },
          };
        }

        if (mode === "selector") {
          const selector = params.selector as string;
          const state = (params.state as string) ?? "visible";
          await page.waitForSelector(selector, {
            state: state as "attached" | "detached" | "visible" | "hidden",
            timeout,
          });
          const elapsed = Date.now() - start;
          return {
            content: [
              {
                type: "text",
                text: `Element ${selector} is now ${state} (waited ${elapsed}ms)`,
              },
            ],
            details: { found: true, selector, waitedMs: elapsed },
          };
        }

        if (mode === "text") {
          const text = params.text as string;
          const gone = (params.textGone as boolean) ?? false;
          if (gone) {
            await page.waitForFunction((t) => !document.body.textContent?.includes(t), text, {
              timeout,
            });
          } else {
            await page.waitForFunction((t) => document.body.textContent?.includes(t), text, {
              timeout,
            });
          }
          const elapsed = Date.now() - start;
          return {
            content: [
              {
                type: "text",
                text: `Text "${text.slice(0, 50)}" ${gone ? "disappeared" : "appeared"} (waited ${elapsed}ms)`,
              },
            ],
            details: { found: !gone, text: text.slice(0, 100), waitedMs: elapsed },
          };
        }

        throw new Error(`Unknown wait mode: ${mode}`);
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Wait timed out after ${Date.now() - start}ms: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
