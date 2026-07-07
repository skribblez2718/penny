/**
 * JavaScript Extension — JS acquisition and deobfuscation for jsa skill
 *
 * Tools: js_download_target, js_deobfuscate, js_inventory
 * Depends on: playwright extension (navigation, snapshot, evaluate)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createLogger } from "../../lib/logger/logger.js";

// Module-level logger for utility functions that run before extension init
const earlyLogger = createLogger("javascript");

// ── Types ──

/**
 * Minimal shape of the object returned by ctx.invokeTool for the playwright
 * tools this extension calls (playwright_navigate / playwright_evaluate).
 * The Pi SDK exposes invokeTool as untyped (ExtensionAPI is `any`), so we
 * describe only the fields we read here.
 */
interface InvokeToolResult {
  result?: string;
}

/** Subset of the extension execution context used by this extension. */
interface ToolInvocationContext {
  invokeTool(name: string, params: Record<string, unknown>): Promise<InvokeToolResult>;
}

/** Shape of the JSON payload produced by the in-page evaluate expression. */
interface ScannedScripts {
  external: Array<{ src: string; type: string; async: boolean; defer: boolean }>;
  inline: Array<{ index: number; content: string; length: number }>;
  links: string[];
}

interface ExternalScriptEntry {
  url: string;
  file: string;
  size: number;
  type: string;
  async: boolean;
  defer: boolean;
}

interface InlineScriptEntry {
  page_url: string;
  index: number;
  content: string;
  length: number;
}

interface JsInventory {
  target_url: string;
  external_scripts: ExternalScriptEntry[];
  inline_scripts: InlineScriptEntry[];
  pages_discovered: string[];
}

interface JsFileEntry {
  name: string;
  path: string;
  size: number;
}

// Parameter shapes matching the typebox schemas declared on each tool below.
interface DownloadTargetParams {
  url: string;
  output_dir?: string;
  crawl_depth?: number;
  include_inline?: boolean;
  timeout?: number;
}

interface DeobfuscateParams {
  file: string;
  method?: string;
}

interface InventoryParams {
  output_dir: string;
}

// ── Helpers ──

function safeFileName(url: string): string {
  const name = basename(url.split("?")[0]) || "script.js";
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// ── Safety: project-root write protection ────────────────────────────────

/**
 * Penny rule: NEVER write temporary files into the project tree. If a
 * caller passes an output_dir that resolves to a path inside a known
 * project location (current working directory or any ancestor containing
 * Penny markers like AGENTS.md / .pi/), redirect to /tmp and warn.
 *
 * This is a defense-in-depth check. The default output_dir is already
 * /tmp/jsa-{hostname}/assets/js; this guard catches the case where a
 * caller mistakenly passes "." or an explicit project-root path.
 */
function resolveSafeOutputDir(requested: string, hostname: string): string {
  const fallback = join(tmpdir(), `jsa-${hostname}`, "assets", "js");
  const resolved = resolve(requested);
  const resolvedFallback = resolve(fallback);

  if (resolved === resolvedFallback) {
    return resolved; // already the safe default — fast path
  }

  // Walk up from the requested dir; if we find Penny markers, this dir
  // is inside the project tree → redirect to /tmp.
  let cursor: string | null = resolved;
  const markers = ["AGENTS.md", ".pi", ".git"];
  while (cursor && cursor !== resolve(cursor, "..")) {
    for (const marker of markers) {
      if (existsSync(join(cursor, marker))) {
        // Suppress repeated warnings by always using the same fallback path.
        earlyLogger.warn(
          `output_dir "${resolved}" is inside the project tree (found ${marker} at ${cursor}). Redirecting to ${resolvedFallback} per Penny's "no temp files in project" rule.`
        );
        return resolvedFallback;
      }
    }
    cursor = resolve(cursor, "..");
  }

  return resolved;
}

// ── Extension ──

export default function javascriptExtension(pi: ExtensionAPI) {
  // ── js_download_target ──

  pi.registerTool({
    name: "js_download_target",
    label: "JS Download Target",
    description: [
      "Download all JavaScript files from a target URL using Playwright.",
      "Discovers: external <script src> files, inline <script> blocks, page links for crawling.",
      "Returns structured JS inventory with file paths and metadata.",
      "Depends on playwright extension for navigation.",
    ].join(" "),
    parameters: Type.Object({
      url: Type.String({ description: "Target URL to download JS from" }),
      output_dir: Type.Optional(
        Type.String({
          description: "Directory to save JS files (default: /tmp/jsa-{hostname}/assets/js)",
        })
      ),
      crawl_depth: Type.Optional(
        Type.Number({ description: "Max crawl depth from root URL (default: 2)", default: 2 })
      ),
      include_inline: Type.Optional(
        Type.Boolean({
          description: "Extract inline <script> blocks (default: true)",
          default: true,
        })
      ),
      timeout: Type.Optional(
        Type.Number({ description: "Page load timeout in ms (default: 30000)", default: 30000 })
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: DownloadTargetParams,
      _signal: AbortSignal,
      _onUpdate: AgentToolUpdateCallback,
      ctx: ToolInvocationContext
    ) => {
      const hostname = new URL(params.url).hostname.replace(/\./g, "-");
      const requestedDir = params.output_dir || join(tmpdir(), `jsa-${hostname}`, "assets", "js");
      const outDir = resolveSafeOutputDir(requestedDir, hostname);
      mkdirSync(outDir, { recursive: true });

      const inventory: JsInventory = {
        target_url: params.url,
        external_scripts: [],
        inline_scripts: [],
        pages_discovered: [],
      };

      try {
        // Navigate to target
        await ctx.invokeTool("playwright_navigate", { url: params.url });

        // Get all <script> tags
        const scriptsResult = await ctx.invokeTool("playwright_evaluate", {
          expression: `JSON.stringify({
            external: Array.from(document.querySelectorAll('script[src]')).map(s => ({
              src: s.src,
              type: s.type || 'text/javascript',
              async: s.async,
              defer: s.defer,
            })),
            inline: Array.from(document.querySelectorAll('script:not([src])')).map((s,i) => ({
              index: i,
              content: s.textContent ? s.textContent.slice(0, 10000) : '',
              length: (s.textContent || '').length,
            })),
            links: Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => h.startsWith('http')),
          })`,
        });

        if (scriptsResult?.result) {
          const data = JSON.parse(scriptsResult.result) as ScannedScripts;

          // Download external scripts
          for (const script of data.external || []) {
            try {
              const contentResult = await ctx.invokeTool("playwright_evaluate", {
                expression: `fetch("${script.src}").then(r => r.text()).catch(() => '')`,
              });
              const content = contentResult?.result || "";

              if (content && content.length > 50) {
                const fileName = safeFileName(script.src);
                const filePath = join(outDir, fileName);
                writeFileSync(filePath, content);

                inventory.external_scripts.push({
                  url: script.src,
                  file: filePath,
                  size: content.length,
                  type: script.type,
                  async: script.async,
                  defer: script.defer,
                });
              }
            } catch {
              // Skip failed downloads
            }
          }

          // Collect inline scripts
          if (params.include_inline) {
            for (const script of data.inline || []) {
              if (script.content) {
                inventory.inline_scripts.push({
                  page_url: params.url,
                  index: script.index,
                  content: script.content,
                  length: script.length,
                });
              }
            }
          }

          // Store discovered pages for crawling
          inventory.pages_discovered = (data.links || []).slice(0, 20);
        }

        // Crawl: basic depth-1 page discovery
        // (Depth > 1 and full crawling is handled by echo agent in ACQUIRE phase)

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  target: params.url,
                  output_dir: outDir,
                  external_count: inventory.external_scripts.length,
                  inline_count: inventory.inline_scripts.length,
                  pages_discovered: inventory.pages_discovered.length,
                  total_js_size: inventory.external_scripts.reduce((s, f) => s + f.size, 0),
                  inventory: inventory,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: err instanceof Error ? err.message : "Failed to download JS",
                  hint: "Ensure playwright extension is available and the target URL is reachable.",
                },
                null,
                2
              ),
            },
          ],
        };
      }
    },
  });

  // ── js_deobfuscate ──

  pi.registerTool({
    name: "js_deobfuscate",
    label: "JS Deobfuscate",
    description: [
      "Deobfuscate minified/obfuscated JavaScript using js-beautify, synchrony, or webcrack.",
      "Tries tools in order: js-beautify (prettify) → synchrony (string-array deobfuscation) → webcrack (bundle unpacking).",
      "Falls back gracefully if tools are not installed.",
    ].join(" "),
    parameters: Type.Object({
      file: Type.String({ description: "Path to JavaScript file to deobfuscate" }),
      method: Type.Optional(
        Type.String({
          description: "Force method: beautify, synchrony, webcrack, auto (default)",
          default: "auto",
        })
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: DeobfuscateParams,
      _signal: AbortSignal,
      _onUpdate: AgentToolUpdateCallback,
      _ctx: ToolInvocationContext
    ) => {
      if (!existsSync(params.file)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: false, error: "File not found: " + params.file }),
            },
          ],
        };
      }

      const source = readFileSync(params.file, "utf-8");
      let result = source;
      let method = "none";

      if (params.method === "auto" || params.method === "beautify") {
        try {
          result = execFileSync("npx", ["js-beautify", "--type", "js", "--stdin"], {
            input: source,
            encoding: "utf-8",
            timeout: 30000,
          });
          method = "beautify";
        } catch {
          // js-beautify not available, try next
        }
      }

      if ((params.method === "auto" || params.method === "synchrony") && method === "none") {
        try {
          result = execFileSync("npx", ["synchrony", "--stdin"], {
            input: source,
            encoding: "utf-8",
            timeout: 30000,
          });
          method = "synchrony";
        } catch {
          // synchrony not available
        }
      }

      if ((params.method === "auto" || params.method === "webcrack") && method === "none") {
        try {
          result = execFileSync("npx", ["webcrack", "--stdin"], {
            input: source,
            encoding: "utf-8",
            timeout: 60000,
          });
          method = "webcrack";
        } catch {
          // webcrack not available
        }
      }

      // Write deobfuscated output
      const outPath = params.file.replace(/\.js$/, ".deobfuscated.js");
      writeFileSync(outPath, result);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                file: params.file,
                output: outPath,
                method: method,
                original_size: source.length,
                deobfuscated_size: result.length,
                changed: source !== result,
              },
              null,
              2
            ),
          },
        ],
      };
    },
  });

  // ── js_inventory ──

  pi.registerTool({
    name: "js_inventory",
    label: "JS Inventory",
    description: [
      "Return a structured inventory of downloaded JavaScript files.",
      "Lists external scripts (URL, local path, size), inline scripts (page, length), and discovered pages.",
      "Used by the ACQUIRE phase to feed split_js_multi().",
    ].join(" "),
    parameters: Type.Object({
      output_dir: Type.String({ description: "Directory where JS files were downloaded" }),
    }),
    execute: async (
      _toolCallId: string,
      params: InventoryParams,
      _signal: AbortSignal,
      _onUpdate: AgentToolUpdateCallback,
      _ctx: ToolInvocationContext
    ) => {
      const jsDir = join(params.output_dir, "assets", "js");
      const files: JsFileEntry[] = [];

      if (existsSync(jsDir)) {
        const { readdirSync, statSync } = await import("node:fs");
        for (const f of readdirSync(jsDir)) {
          const filePath = join(jsDir, f);
          try {
            const stat = statSync(filePath);
            files.push({
              name: f,
              path: filePath,
              size: stat.size,
            });
          } catch {
            // Skip entries that can't be stat'd (e.g. removed mid-scan)
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                output_dir: params.output_dir,
                js_files: files.length,
                total_size: files.reduce((s, f) => s + f.size, 0),
                files: files,
              },
              null,
              2
            ),
          },
        ],
      };
    },
  });

  const logger = createLogger("javascript");
  logger.info("JS acquisition extension loaded", {
    tools: ["js_download_target", "js_deobfuscate", "js_inventory"],
  });
}
