/**
 * Testing Assertion Tools
 *
 * browser_verify_element_visible, browser_verify_text_visible,
 * browser_verify_value, browser_generate_locator
 *
 * Translated from MCP: verify.ts, snapshot.ts (generate_locator)
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BrowserManager } from "../browser.js";
import type { PlaywrightConfig } from "../types.js";

export function registerTestingTools(pi: ExtensionAPI, _config: PlaywrightConfig) {
  const browser = BrowserManager.getBrowser();

  // ==========================================================================
  // playwright_verify_element_visible
  // ==========================================================================
  pi.registerTool({
    name: "playwright_verify_element_visible",
    label: "Verify Element Visible",
    description:
      "Assert that an element is visible on the page. Returns success/failure with details.",
    promptSnippet: "Check if an element is visible",
    promptGuidelines: [
      "Use playwright_verify_element_visible to confirm elements are present.",
      "For vulnerability validation: confirm that injected content actually renders.",
      "Returns element details when found.",
    ],
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector for the element to verify",
      }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 5000)" })),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const selector = params.selector as string;

      try {
        const locator = page.locator(selector).first();
        await locator.waitFor({
          state: "visible",
          timeout: (params.timeout as number) ?? 5000,
        });

        const tagName = await locator.evaluate((el) => el.tagName.toLowerCase());
        const text = await locator.textContent().catch(() => "");
        const visible = await locator.isVisible();

        return {
          content: [
            {
              type: "text",
              text: `✅ Element visible: <${tagName}>${selector}${text ? ` "${text.trim().slice(0, 100)}"` : ""}`,
            },
          ],
          details: {
            visible,
            selector,
            elementTag: tagName,
            elementText: text?.trim().slice(0, 200),
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Element NOT visible: ${selector} — ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
          details: { visible: false, selector },
        };
      }
    },
  });

  // ==========================================================================
  // playwright_verify_text_visible
  // ==========================================================================
  pi.registerTool({
    name: "playwright_verify_text_visible",
    label: "Verify Text Visible",
    description: "Assert that specific text is visible on the page.",
    promptSnippet: "Check if text appears on the page",
    promptGuidelines: [
      "Use playwright_verify_text_visible to confirm expected text rendered.",
      "For vulnerability validation: verify alert messages or injected content displays.",
      "Text matching is case-sensitive and looks at visible text content.",
    ],
    parameters: Type.Object({
      text: Type.String({
        description: "Text to search for on the page",
      }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 5000)" })),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const text = params.text as string;

      try {
        await page
          .getByText(text)
          .first()
          .waitFor({
            state: "visible",
            timeout: (params.timeout as number) ?? 5000,
          });

        return {
          content: [
            {
              type: "text",
              text: `✅ Text visible: "${text.slice(0, 100)}"`,
            },
          ],
          details: { visible: true, text },
        };
      } catch {
        // Check if text exists anywhere (not just as its own element)
        try {
          await page.waitForFunction((t) => document.body.innerText.includes(t), text, {
            timeout: 1000,
          });
          return {
            content: [
              {
                type: "text",
                text: `✅ Text found in page (not standalone): "${text.slice(0, 100)}"`,
              },
            ],
            details: { visible: true, text, standalone: false },
          };
        } catch {
          return {
            content: [
              {
                type: "text",
                text: `❌ Text NOT found: "${text.slice(0, 100)}"`,
              },
            ],
            isError: true,
            details: { visible: false, text },
          };
        }
      }
    },
  });

  // ==========================================================================
  // playwright_verify_value
  // ==========================================================================
  pi.registerTool({
    name: "playwright_verify_value",
    label: "Verify Input Value",
    description: "Assert that an input element has a specific value.",
    promptSnippet: "Check an input element's value",
    promptGuidelines: [
      "Use playwright_verify_value to verify form fields are filled correctly.",
      "For security testing: verify injected values appear in form fields.",
    ],
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector for the input element",
      }),
      expectedValue: Type.String({
        description: "Expected value of the input",
      }),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const selector = params.selector as string;
      const expected = params.expectedValue as string;

      try {
        const actual = await page.locator(selector).first().inputValue();

        if (actual === expected) {
          return {
            content: [
              {
                type: "text",
                text: `✅ Value matches: ${selector} = "${expected.slice(0, 80)}"`,
              },
            ],
            details: { matches: true, selector, expected, actual },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `❌ Value mismatch: ${selector}\n  Expected: "${expected.slice(0, 80)}"\n  Actual:   "${actual.slice(0, 80)}"`,
            },
          ],
          isError: true,
          details: { matches: false, selector, expected, actual },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Cannot verify value: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
