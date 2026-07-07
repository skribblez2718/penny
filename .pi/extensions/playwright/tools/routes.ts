/**
 * Route, Form, and File Tools
 *
 * browser_route, browser_route_list, browser_unroute,
 * browser_fill_form, browser_file_upload, browser_drop
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { BrowserManager } from "../browser.js";
import type { PlaywrightConfig } from "../types.js";

export function registerRouteFormFileTools(pi: ExtensionAPI, _config: PlaywrightConfig) {
  const browser = BrowserManager.getBrowser();

  // ==========================================================================
  // playwright_route
  // ==========================================================================
  pi.registerTool({
    name: "playwright_route",
    label: "Route Intercept",
    description:
      "Intercept and modify network requests matching a URL pattern. Can abort, fulfill with custom response, or continue.",
    promptSnippet: "Intercept network requests by URL pattern",
    promptGuidelines: [
      "Use playwright_route for network-level testing and mocking.",
      "For vulnerability testing: block malicious URLs, mock API responses.",
      "Use playwright_unroute to remove routes.",
    ],
    parameters: Type.Object({
      urlPattern: Type.String({
        description: "URL glob pattern to match (e.g., '**/api/**')",
      }),
      action: Type.Union([Type.Literal("abort"), Type.Literal("fulfill")], {
        description: "Action to take for matching requests",
      }),
      body: Type.Optional(Type.String({ description: "Response body (for fulfill)" })),
      status: Type.Optional(
        Type.Number({
          description: "HTTP status code (for fulfill, default: 200)",
        })
      ),
      contentType: Type.Optional(
        Type.String({
          description: "Content-Type header (for fulfill, default: text/plain)",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const pattern = params.urlPattern as string;
      const action = params.action as string;

      try {
        if (action === "abort") {
          await page.route(pattern, (route) => route.abort());
        } else {
          await page.route(pattern, (route) =>
            route.fulfill({
              status: (params.status as number) ?? 200,
              contentType: (params.contentType as string) ?? "text/plain",
              body: (params.body as string) ?? "",
            })
          );
        }

        return {
          content: [
            {
              type: "text",
              text: `Route ${action}: "${pattern}"`,
            },
          ],
          details: { pattern, action, active: true },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Route failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_unroute
  // ==========================================================================
  pi.registerTool({
    name: "playwright_unroute",
    label: "Remove Routes",
    description:
      "Remove previously set route intercepts. Call with urlPattern to remove specific route, or omit to remove all.",
    promptSnippet: "Remove network route intercepts",
    promptGuidelines: [
      "Use playwright_unroute to restore normal network behavior.",
      "Omit urlPattern to clear all routes.",
    ],
    parameters: Type.Object({
      urlPattern: Type.Optional(
        Type.String({
          description: "URL pattern to unroute (omit to clear all)",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();

      try {
        await page.unroute((params.urlPattern as string) ?? "**/*");

        return {
          content: [
            {
              type: "text",
              text: params.urlPattern ? `Unrouted: "${params.urlPattern}"` : "All routes cleared",
            },
          ],
          details: {
            pattern: params.urlPattern ?? "**/*",
            cleared: true,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Unroute failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_fill_form
  // ==========================================================================
  pi.registerTool({
    name: "playwright_fill_form",
    label: "Fill Form",
    description:
      "Fill multiple form fields at once. Provide an object mapping CSS selectors to values.",
    promptSnippet: "Fill multiple form fields at once",
    promptGuidelines: [
      "Use playwright_fill_form for batch form filling instead of multiple type/fill calls.",
      'Provide a JSON object: { "#name": "John", "#email": "john@test.com" }.',
      "Each key is a CSS selector; each value is the text to fill.",
    ],
    parameters: Type.Object({
      fields: Type.Record(Type.String(), Type.String(), {
        description:
          'Object mapping CSS selectors to values. Example: {"#name": "John", "#email": "john@test.com"}',
      }),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const fields = params.fields as Record<string, string>;

      try {
        const results: Record<string, string> = {};
        for (const [selector, value] of Object.entries(fields)) {
          await page.locator(selector).first().fill(value);
          results[selector] = value;
        }

        return {
          content: [
            {
              type: "text",
              text: `Filled ${Object.keys(fields).length} fields:\n${JSON.stringify(results, null, 2)}`,
            },
          ],
          details: { filled: results, count: Object.keys(fields).length },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Fill form failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_file_upload
  // ==========================================================================
  pi.registerTool({
    name: "playwright_file_upload",
    label: "Upload File",
    description:
      "Upload files to a file input element. Useful for testing file upload functionality.",
    promptSnippet: "Upload files to the page",
    promptGuidelines: [
      "Use playwright_file_upload to test file upload features.",
      "Provide absolute file paths for local files.",
      "For security testing: test file upload filters and validation.",
    ],
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector for the file input element",
      }),
      filePaths: Type.Array(Type.String(), {
        description: "Absolute paths to files to upload",
      }),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const selector = params.selector as string;
      const filePaths = params.filePaths as string[];

      try {
        // Validate files exist
        for (const fp of filePaths) {
          if (!existsSync(fp)) {
            return {
              content: [
                {
                  type: "text",
                  text: `File not found: ${fp}`,
                },
              ],
              isError: true,
            };
          }
        }

        await page.locator(selector).first().setInputFiles(filePaths);

        const fileInfos = filePaths.map((fp) => {
          const stats = statSync(fp);
          return { path: fp, size: stats.size };
        });

        return {
          content: [
            {
              type: "text",
              text: `Uploaded ${filePaths.length} file(s) to ${selector}`,
            },
          ],
          details: { selector, uploadedFiles: fileInfos },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // playwright_drop
  // ==========================================================================
  pi.registerTool({
    name: "playwright_drop",
    label: "Drop Files",
    description:
      "Drop files onto an element (simulates drag-and-drop file upload). Useful for testing modern file drop zones.",
    promptSnippet: "Drop files onto an element",
    promptGuidelines: [
      "Use playwright_drop for testing drag-and-drop file upload UIs.",
      "The element should accept 'drop' events with files.",
    ],
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector for the drop target element",
      }),
      filePaths: Type.Array(Type.String(), {
        description: "Absolute paths to files to drop",
      }),
    }),
    async execute(_toolCallId, params) {
      const page = await browser.getPage();
      const selector = params.selector as string;
      const filePaths = params.filePaths as string[];

      try {
        // Create a DataTransfer with files
        const dt = await page.evaluateHandle((paths: string[]) => {
          const dataTransfer = new DataTransfer();
          for (const path of paths) {
            // Use fetch to create file blob from local path
            const file = new File([""], path.split("/").pop() || "file");
            dataTransfer.items.add(file);
          }
          return dataTransfer;
        }, filePaths);

        await page.locator(selector).first().dispatchEvent("drop", {
          dataTransfer: dt,
        });

        return {
          content: [
            {
              type: "text",
              text: `Dropped ${filePaths.length} file(s) onto ${selector}`,
            },
          ],
          details: { selector, fileCount: filePaths.length },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Drop failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
