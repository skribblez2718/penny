import { registerTool } from "../../../lib/pi-tool-registration.js";
/**
 * Input Tools — Type, Fill, Select, Check, Uncheck, Press Key
 *
 * Translated from MCP: keyboard.ts, form.ts, snapshot.ts (select), files.ts
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BrowserManager } from "../browser.js";
import type { PlaywrightConfig } from "../types.js";

export function registerInputTools(pi: ExtensionAPI, _config: PlaywrightConfig) {
  const browser = BrowserManager.getBrowser();

  // ==========================================================================
  // playwright_type
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_type",
    label: "Type Text",
    description:
      "Type text into an editable element character by character, with optional clearing and delay. Use when per-keystroke events matter; prefer playwright_fill for fast whole-value replacement.",
    promptSnippet: "Type text into an input field",
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector for the editable element",
      }),
      text: Type.String({ description: "Text to type" }),
      delay: Type.Optional(
        Type.Number({
          description: "Delay between keystrokes in ms (default: 0)",
          minimum: 0,
        })
      ),
      clear: Type.Optional(
        Type.Boolean({
          description: "Clear existing text first (default: false)",
        })
      ),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 5000)" })),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const selector = params.selector;
      const text = params.text;

      try {
        const locator = page.locator(selector).first();
        await locator.focus();

        if (params.clear) {
          await locator.clear();
        }

        await locator.type(text, {
          delay: params.delay ?? 0,
          timeout: params.timeout ?? 5000,
        });

        const value = await locator.inputValue().catch(() => "");

        return {
          content: [
            {
              type: "text",
              text: `Typed into ${selector}: "${text.slice(0, 80)}"${text.length > 80 ? "..." : ""}`,
            },
          ],
          details: { selector, length: text.length, valuePreview: value.slice(0, 100) },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Type failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_fill
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_fill",
    label: "Fill Field",
    description:
      "Fill an input field with text, replacing existing content. Faster than playwright_type for large text. Does not trigger individual keystroke events.",
    promptSnippet: "Fill an input with text",
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector for the input/textarea element",
      }),
      value: Type.String({ description: "Value to fill" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 5000)" })),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const selector = params.selector;

      try {
        const locator = page.locator(selector).first();
        await locator.fill(params.value, {
          timeout: params.timeout ?? 5000,
        });

        return {
          content: [
            {
              type: "text",
              text: `Filled ${selector}`,
            },
          ],
          details: { selector, value: params.value },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Fill failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_select_option
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_select_option",
    label: "Select Option",
    description:
      "Select one or more options from a select/dropdown element by value, label, or index.",
    promptSnippet: "Select an option from a dropdown",
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector for the select element",
      }),
      values: Type.Array(Type.String(), {
        description: "Option values/labels/indices to select",
      }),
      mode: Type.Optional(
        Type.Union([Type.Literal("value"), Type.Literal("label"), Type.Literal("index")], {
          description: "Selection mode (default: value)",
        })
      ),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 5000)" })),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const selector = params.selector;
      const mode = params.mode ?? "value";

      try {
        const locator = page.locator(selector).first();

        if (mode === "index") {
          await locator.selectOption(
            params.values.map((v) => ({ index: parseInt(v, 10) })),
            { timeout: params.timeout ?? 5000 }
          );
        } else if (mode === "label") {
          await locator.selectOption(
            params.values.map((v) => ({ label: v })),
            { timeout: params.timeout ?? 5000 }
          );
        } else {
          await locator.selectOption(params.values, {
            timeout: params.timeout ?? 5000,
          });
        }

        const selected = await locator
          .evaluate((el) => {
            if (!(el instanceof HTMLSelectElement)) {
              throw new TypeError("selected element is not a select control");
            }
            return Array.from(el.selectedOptions).map((option) => option.textContent);
          })
          .catch(() => []);

        return {
          content: [
            {
              type: "text",
              text: `Selected in ${selector}: ${selected.join(", ")}`,
            },
          ],
          details: { selector, selectedValues: selected },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Select failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_check
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_check",
    label: "Check Checkbox",
    description:
      "Check a checkbox or radio button by selector. This is a no-op when already checked; use playwright_click on its label when the control itself is hidden.",
    promptSnippet: "Check a checkbox or radio",
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector for the checkbox/radio element",
      }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 5000)" })),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const selector = params.selector;

      try {
        const locator = page.locator(selector).first();
        const wasChecked = await locator.isChecked().catch(() => false);
        await locator.check({
          timeout: params.timeout ?? 5000,
        });

        return {
          content: [
            {
              type: "text",
              text: `Checked ${selector}${wasChecked ? " (was already checked)" : ""}`,
            },
          ],
          details: { selector, checked: true, wasAlreadyChecked: wasChecked },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Check failed: ${err instanceof Error ? err.message : String(err)}\nTry clicking the label element if the input is hidden.`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_uncheck
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_uncheck",
    label: "Uncheck Checkbox",
    description:
      "Uncheck a checkbox by selector. This is a no-op when the control is already unchecked.",
    promptSnippet: "Uncheck a checkbox",
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector for the checkbox element",
      }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 5000)" })),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const selector = params.selector;

      try {
        const locator = page.locator(selector).first();
        const wasChecked = await locator.isChecked().catch(() => true);
        await locator.uncheck({
          timeout: params.timeout ?? 5000,
        });

        return {
          content: [
            {
              type: "text",
              text: `Unchecked ${selector}${!wasChecked ? " (was already unchecked)" : ""}`,
            },
          ],
          details: { selector, checked: false, wasAlreadyUnchecked: !wasChecked },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Uncheck failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_press_key
  // ==========================================================================
  registerTool(pi, {
    name: "playwright_press_key",
    label: "Press Key",
    description:
      "Press a keyboard key or modified shortcut on the page, optionally after focusing an element. Use for special keys and shortcuts; prefer playwright_type or playwright_fill for text entry.",
    promptSnippet: "Press a keyboard key",
    parameters: Type.Object({
      key: Type.String({
        description: "Key to press (e.g., 'Enter', 'Escape', 'Tab', 'ArrowDown', 'PageDown')",
      }),
      selector: Type.Optional(
        Type.String({
          description: "CSS selector of element to focus before pressing key",
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
          { description: "Modifier keys to hold" }
        )
      ),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 5000)" })),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();

      try {
        if (params.selector) {
          await page.locator(params.selector).first().focus();
        }

        const modifiers = params.modifiers;
        if (modifiers?.length) {
          const combo = modifiers.join("+") + "+" + params.key;
          await page.keyboard.press(combo);
        } else {
          await page.keyboard.press(params.key);
        }

        return {
          content: [
            {
              type: "text",
              text: `Pressed: ${modifiers?.length ? modifiers.join("+") + "+" : ""}${params.key}`,
            },
          ],
          details: {
            key: params.key,
            modifiers: modifiers ?? [],
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Press failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
