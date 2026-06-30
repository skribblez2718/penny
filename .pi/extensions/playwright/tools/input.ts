/**
 * Input Tools — Type, Fill, Select, Check, Uncheck, Press Key
 *
 * Translated from MCP: keyboard.ts, form.ts, snapshot.ts (select), files.ts
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BrowserManager } from "../browser.js";
import type { PlaywrightConfig } from "../types.js";

export function registerInputTools(pi: ExtensionAPI, _config: PlaywrightConfig) {
  const browser = BrowserManager.getBrowser();

  // ==========================================================================
  // playwright_type
  // ==========================================================================
  pi.registerTool({
    name: "playwright_type",
    label: "Type Text",
    description:
      "Type text into an editable element. Focuses the element first, then types character by character with optional delay between keystrokes.",
    promptSnippet: "Type text into an input field",
    promptGuidelines: [
      "Use playwright_snapshot first to find the input element.",
      "Use playwright_type for text inputs, textareas, and contenteditable elements.",
      "Use playwright_fill to replace entire field content at once.",
      "To clear existing content first, use playwright_fill or playwright_type with clear: true.",
    ],
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
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in ms (default: 5000)" })
      ),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const selector = params.selector as string;
      const text = params.text as string;

      try {
        const locator = page.locator(selector).first();
        await locator.focus();

        if (params.clear) {
          await locator.clear();
        }

        await locator.type(text, {
          delay: (params.delay as number) ?? 0,
          timeout: (params.timeout as number) ?? 5000,
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
  pi.registerTool({
    name: "playwright_fill",
    label: "Fill Field",
    description:
      "Fill an input field with text, replacing existing content. Faster than playwright_type for large text. Does not trigger individual keystroke events.",
    promptSnippet: "Fill an input with text",
    promptGuidelines: [
      "Use playwright_fill to quickly set a field's value, replacing existing content.",
      "Use playwright_type when you need to trigger per-keystroke events or want typing delay.",
      "For textareas with large content, playwright_fill is faster than playwright_type.",
    ],
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector for the input/textarea element",
      }),
      value: Type.String({ description: "Value to fill" }),
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in ms (default: 5000)" })
      ),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const selector = params.selector as string;

      try {
        const locator = page.locator(selector).first();
        await locator.fill(params.value as string, {
          timeout: (params.timeout as number) ?? 5000,
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
  pi.registerTool({
    name: "playwright_select_option",
    label: "Select Option",
    description:
      "Select one or more options from a select/dropdown element by value, label, or index.",
    promptSnippet: "Select an option from a dropdown",
    promptGuidelines: [
      "Use playwright_snapshot first to find the select element.",
      "Select by value: use the option's value attribute.",
      "Select by label: use the visible text of the option.",
      "Select by index: 0-based position in the dropdown.",
    ],
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector for the select element",
      }),
      values: Type.Array(Type.String(), {
        description: "Option values/labels/indices to select",
      }),
      mode: Type.Optional(
        Type.Union(
          [Type.Literal("value"), Type.Literal("label"), Type.Literal("index")],
          { description: "Selection mode (default: value)" }
        )
      ),
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in ms (default: 5000)" })
      ),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const selector = params.selector as string;
      const mode = (params.mode as string) ?? "value";

      try {
        const locator = page.locator(selector).first();

        if (mode === "index") {
          await locator.selectOption(
            (params.values as string[]).map((v) => ({ index: parseInt(v, 10) })),
            { timeout: (params.timeout as number) ?? 5000 }
          );
        } else if (mode === "label") {
          await locator.selectOption(
            (params.values as string[]).map((v) => ({ label: v })),
            { timeout: (params.timeout as number) ?? 5000 }
          );
        } else {
          await locator.selectOption(params.values as string[], {
            timeout: (params.timeout as number) ?? 5000,
          });
        }

        const selected = await locator
          .evaluate((el) =>
            Array.from((el as HTMLSelectElement).selectedOptions).map(
              (o) => o.textContent
            )
          )
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
  pi.registerTool({
    name: "playwright_check",
    label: "Check Checkbox",
    description: "Check a checkbox or radio button.",
    promptSnippet: "Check a checkbox or radio",
    promptGuidelines: [
      "Use playwright_snapshot first to find the checkbox/radio.",
      "If the input is hidden behind a label, click the label instead.",
      "No-op if already checked — returns current state.",
    ],
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector for the checkbox/radio element",
      }),
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in ms (default: 5000)" })
      ),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const selector = params.selector as string;

      try {
        const locator = page.locator(selector).first();
        const wasChecked = await locator.isChecked().catch(() => false);
        await locator.check({
          timeout: (params.timeout as number) ?? 5000,
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
  pi.registerTool({
    name: "playwright_uncheck",
    label: "Uncheck Checkbox",
    description: "Uncheck a checkbox.",
    promptSnippet: "Uncheck a checkbox",
    promptGuidelines: [
      "Use playwright_snapshot first to find the checkbox.",
      "No-op if already unchecked.",
    ],
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector for the checkbox element",
      }),
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in ms (default: 5000)" })
      ),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const selector = params.selector as string;

      try {
        const locator = page.locator(selector).first();
        const wasChecked = await locator.isChecked().catch(() => true);
        await locator.uncheck({
          timeout: (params.timeout as number) ?? 5000,
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
  pi.registerTool({
    name: "playwright_press_key",
    label: "Press Key",
    description:
      "Press a keyboard key on the page. Supports special keys like Enter, Escape, Tab, ArrowDown, etc.",
    promptSnippet: "Press a keyboard key",
    promptGuidelines: [
      "Use playwright_press_key to simulate keyboard input.",
      "Common keys: Enter, Escape, Tab, Space, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Backspace, Delete.",
      "For typing text into fields, use playwright_type or playwright_fill instead.",
      "Combine with modifiers for shortcuts: Control+C, Shift+Tab, etc.",
    ],
    parameters: Type.Object({
      key: Type.String({
        description:
          "Key to press (e.g., 'Enter', 'Escape', 'Tab', 'ArrowDown', 'PageDown')",
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
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in ms (default: 5000)" })
      ),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();

      try {
        if (params.selector) {
          await page.locator(params.selector as string).first().focus();
        }

        const modifiers = params.modifiers as string[] | undefined;
        if (modifiers?.length) {
          const combo =
            modifiers.join("+") + "+" + (params.key as string);
          await page.keyboard.press(combo);
        } else {
          await page.keyboard.press(params.key as string);
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
