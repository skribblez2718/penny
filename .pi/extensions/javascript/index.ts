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
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createLogger } from "../../lib/logger/logger.js";

// Module-level logger for utility functions that run before extension init
const earlyLogger = createLogger("javascript");

// ── Helpers ──

function slugify(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/\./g, "-");
    const path = u.pathname.replace(/\//g, "-").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
    return `${host}${path ? "-" + path : ""}`;
  } catch {
    return url.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 60);
  }
}

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
          `output_dir "${resolved}" is inside the project tree (found ${marker} at ${cursor}). Redirecting to ${resolvedFallback} per Penny's "no temp files in project" rule.`,
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
      output_dir: Type.Optional(Type.String({ description: "Directory to save JS files (default: /tmp/jsa-{hostname}/assets/js)" })),
      crawl_depth: Type.Optional(Type.Number({ description: "Max crawl depth from root URL (default: 2)", default: 2 })),
      include_inline: Type.Optional(Type.Boolean({ description: "Extract inline <script> blocks (default: true)", default: true })),
      timeout: Type.Optional(Type.Number({ description: "Page load timeout in ms (default: 30000)", default: 30000 })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const hostname = new URL(params.url).hostname.replace(/\./g, "-");
      const requestedDir = params.output_dir || join(tmpdir(), `jsa-${hostname}`, "assets", "js");
      const outDir = resolveSafeOutputDir(requestedDir, hostname);
      mkdirSync(outDir, { recursive: true });
      
      const inventory: any = {
        target_url: params.url,
        external_scripts: [] as any[],
        inline_scripts: [] as any[],
        pages_discovered: [] as string[],
      };
      
      try {
        // Navigate to target
        const navResult = await ctx.invokeTool("playwright_navigate", { url: params.url });
        
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
          })`
        });
        
        if (scriptsResult?.result) {
          const data = JSON.parse(scriptsResult.result);
          
          // Download external scripts
          for (const script of data.external || []) {
            try {
              const contentResult = await ctx.invokeTool("playwright_evaluate", {
                expression: `fetch("${script.src}").then(r => r.text()).catch(() => '')`
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
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              target: params.url,
              output_dir: outDir,
              external_count: inventory.external_scripts.length,
              inline_count: inventory.inline_scripts.length,
              pages_discovered: inventory.pages_discovered.length,
              total_js_size: inventory.external_scripts.reduce((s: number, f: any) => s + f.size, 0),
              inventory: inventory,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: err.message || "Failed to download JS",
              hint: "Ensure playwright extension is available and the target URL is reachable.",
            }, null, 2),
          }],
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
      method: Type.Optional(Type.String({ description: "Force method: beautify, synchrony, webcrack, auto (default)", default: "auto" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      if (!existsSync(params.file)) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "File not found: " + params.file }) }] };
      }
      
      const source = readFileSync(params.file, "utf-8");
      let result = source;
      let method = "none";
      
      if (params.method === "auto" || params.method === "beautify") {
        try {
          result = execFileSync("npx", ["js-beautify", "--type", "js", "--stdin"], {
            input: source, encoding: "utf-8", timeout: 30000,
          });
          method = "beautify";
        } catch {
          // js-beautify not available, try next
        }
      }
      
      if ((params.method === "auto" || params.method === "synchrony") && method === "none") {
        try {
          result = execFileSync("npx", ["synchrony", "--stdin"], {
            input: source, encoding: "utf-8", timeout: 30000,
          });
          method = "synchrony";
        } catch {
          // synchrony not available
        }
      }
      
      if ((params.method === "auto" || params.method === "webcrack") && method === "none") {
        try {
          result = execFileSync("npx", ["webcrack", "--stdin"], {
            input: source, encoding: "utf-8", timeout: 60000,
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
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            file: params.file,
            output: outPath,
            method: method,
            original_size: source.length,
            deobfuscated_size: result.length,
            changed: source !== result,
          }, null, 2),
        }],
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
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const jsDir = join(params.output_dir, "assets", "js");
      const files: any[] = [];
      
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
          } catch {}
        }
      }
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            output_dir: params.output_dir,
            js_files: files.length,
            total_size: files.reduce((s, f) => s + f.size, 0),
            files: files,
          }, null, 2),
        }],
      };
    },
  });
  
  const logger = createLogger("javascript");
  logger.info("JS acquisition extension loaded", { tools: ["js_download_target", "js_deobfuscate", "js_inventory"] });
}
