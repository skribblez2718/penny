import { registerTool } from "../../../lib/pi-tool-registration.js";
/**
 * Evaluate & Wait Tools
 *
 * browser_evaluate, browser_wait_for
 *
 * Translated from MCP: evaluate.ts, wait.ts
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BrowserManager } from "../browser.js";
import type { PlaywrightConfig } from "../types.js";

export function registerEvaluateTools(pi: ExtensionAPI, _config: PlaywrightConfig) {
  const browser = BrowserManager.getBrowser();

  // ==========================================================================
  // playwright_evaluate
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_evaluate",
    label: "Evaluate JavaScript",
    description:
      "Execute JavaScript in the browser page context. Returns the result. Use for data extraction, DOM inspection, and interacting with page JavaScript. Runs in browser sandbox (no Node.js access).",
    promptSnippet: "Execute JavaScript in the page",
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
      const expression = params.expression;
      const selector = params.selector;

      try {
        let result: unknown;
        if (selector) {
          const locator = page.locator(selector).first();
          result = await locator.evaluate((el, expr) => {
            const isCallable = (value: unknown): value is (...args: unknown[]) => unknown =>
              typeof value === "function";
            const evaluated: unknown = eval(`(${expr})`);
            return isCallable(evaluated) ? evaluated(el) : evaluated;
          }, expression);
        } else {
          result = await page.evaluate((expr) => {
            const isCallable = (value: unknown): value is (...args: unknown[]) => unknown =>
              typeof value === "function";
            const evaluated: unknown = eval(`(${expr})`);
            return isCallable(evaluated) ? evaluated() : evaluated;
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
  registerTool(pi, {
    name: "playwright_wait_for",
    label: "Wait For",
    description:
      "Wait for a condition on the page: an element to appear/disappear, text to appear, or a specified amount of time.",
    promptSnippet: "Wait for element or time on the page",
    parameters: Type.Union([
      Type.Object({
        mode: Type.Literal("selector", { description: "Wait mode" }),
        selector: Type.String({ description: "CSS selector to wait for" }),
        state: Type.Optional(
          Type.Union([
            Type.Literal("visible"),
            Type.Literal("hidden"),
            Type.Literal("attached"),
            Type.Literal("detached"),
          ])
        ),
        timeout: Type.Optional(
          Type.Number({ description: "Maximum wait timeout in ms (default: 30000)" })
        ),
      }),
      Type.Object({
        mode: Type.Literal("text", { description: "Wait mode" }),
        text: Type.String({ description: "Text to wait for to appear or disappear" }),
        textGone: Type.Optional(
          Type.Boolean({ description: "Wait for text to disappear (default: false)" })
        ),
        timeout: Type.Optional(
          Type.Number({ description: "Maximum wait timeout in ms (default: 30000)" })
        ),
      }),
      Type.Object({
        mode: Type.Literal("time", { description: "Wait mode" }),
        ms: Type.Optional(
          Type.Number({
            description: "Milliseconds to wait (default: 1000, max: 60000)",
            minimum: 0,
            maximum: 60000,
          })
        ),
      }),
    ]),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const mode = params.mode;
      const timeout = "timeout" in params ? (params.timeout ?? 30000) : 30000;
      const start = Date.now();

      try {
        if (mode === "time") {
          const ms = params.ms ?? 1000;
          await page.waitForTimeout(ms);
          return {
            content: [{ type: "text", text: `Waited ${ms}ms` }],
            details: { waitedMs: ms },
          };
        }

        if (mode === "selector") {
          const selector = params.selector;
          const state = params.state ?? "visible";
          await page.waitForSelector(selector, {
            state,
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
          const text = params.text;
          const gone = params.textGone ?? false;
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
