import { registerTool } from "../../lib/pi-tool-registration.js";
/**
 * Word Extension
 *
 * Generate professionally styled Word documents from Markdown. TypeScript owns
 * validation, rendering, OOXML validation, and atomic publication in process.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { createLogger, setSessionId } from "../../lib/logger/logger.js";
import { generate, type GeneratorHooks, type WordGenerationResult } from "./renderer.js";

const logger = createLogger("word");

export const WORD_THEMES = ["executive", "modern", "minimal", "editorial", "tech"] as const;

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_STAGING_ATTEMPTS = 10;
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const DISCOVERED_PROJECT_ROOT = path.resolve(EXTENSION_DIR, "../../..");

// ── Path helpers (exported for tests) ───────────────────────────────────────

export function getExtensionDir(): string {
  return EXTENSION_DIR;
}

export function getProjectRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PROJECT_ROOT?.trim();
  return configured ? path.resolve(configured) : DISCOVERED_PROJECT_ROOT;
}

/** Lowercase, alphanumeric-and-dash slug for filenames; never empty. */
export function slugify(input: string, fallback = "document"): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || fallback;
}

/** Default output path: a unique per-run file in the OS temp directory. */
export function defaultOutputPath(title: string | undefined, now: Date = new Date()): string {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  const time = [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const unique = `${String(now.getMilliseconds()).padStart(3, "0")}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const name = `${slugify(title || "document")}_${stamp}_${time}_${unique}.docx`;
  return path.join(os.tmpdir(), "penny", "word", name);
}

export function resolveOutputPath(
  outputPath: string | undefined,
  title: string | undefined,
  projectRoot: string
): string {
  if (!outputPath) return defaultOutputPath(title);
  const resolved = path.isAbsolute(outputPath) ? outputPath : path.join(projectRoot, outputPath);
  return resolved.toLowerCase().endsWith(".docx") ? resolved : `${resolved}.docx`;
}

/** Reserve a parent-owned same-directory staging path for one invocation. */
export function reserveStagingPath(outputPath: string): string {
  const target = path.resolve(outputPath);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  for (let attempt = 0; attempt < MAX_STAGING_ATTEMPTS; attempt += 1) {
    const candidate = path.join(
      directory,
      `.${path.basename(target, ".docx")}.${randomUUID()}.tmp.docx`
    );
    try {
      const descriptor = fs.openSync(candidate, "wx", 0o600);
      fs.closeSync(descriptor);
      return candidate;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Unable to reserve a unique Word staging file beside ${target}`);
}

// ── Generator invocation ───────────────────────────────────────────────────

export interface GeneratorOutcome {
  cancelled: boolean;
  result?: WordGenerationResult;
}

export interface GeneratorRunOptions {
  timeoutMs?: number;
  hooks?: GeneratorHooks;
}

function generatorTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PENNY_DOCGEN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export async function runGenerator(
  spec: Record<string, unknown>,
  signal: AbortSignal | undefined,
  options: GeneratorRunOptions = {}
): Promise<GeneratorOutcome> {
  if (signal?.aborted) return { cancelled: true };

  const outputPath = spec.output_path;
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new Error("Document generator spec requires output_path");
  }

  const stagingPath = reserveStagingPath(outputPath);
  const preparedSpec = { ...spec, staging_path: stagingPath };
  const timeoutMs = options.timeoutMs ?? generatorTimeoutMs();
  const internalController = new AbortController();
  let timedOut = false;

  const forwardAbort = () => internalController.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    internalController.abort();
  }, timeoutMs);

  try {
    const result = await generate(preparedSpec, internalController.signal, options.hooks ?? {});
    return { cancelled: false, result };
  } catch (error) {
    if (timedOut) {
      throw new Error(`Document generator timed out after ${timeoutMs}ms`);
    }
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      return { cancelled: true };
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
    fs.rmSync(stagingPath, { force: true });
  }
}

// ── Tool parameters ────────────────────────────────────────────────────────

const wordGenerateParams = Type.Object({
  markdown: Type.Optional(
    Type.String({
      description:
        "Full markdown content to render. Supports headings H1–H6, paragraphs, **bold**, " +
        "*italic*, `inline code`, ~~strikethrough~~, [links](url), nested bullet and numbered " +
        "lists, tables, fenced code blocks, blockquotes, horizontal rules, and local images " +
        "(![caption](path)). Exactly one of 'markdown' or 'markdown_path' is required.",
    })
  ),
  markdown_path: Type.Optional(
    Type.String({
      description:
        "Path to a markdown file instead of inline 'markdown'. Relative paths resolve " +
        "against the project root.",
    })
  ),
  title: Type.Optional(
    Type.String({
      description:
        "Document title. Defaults to the first H1. The leading H1 is removed from the body " +
        "when title_mode renders separate title matter.",
    })
  ),
  subtitle: Type.Optional(
    Type.String({ description: "Subtitle rendered under the title in muted text." })
  ),
  author: Type.Optional(
    Type.String({ description: "Author shown on the title block or cover page." })
  ),
  date: Type.Optional(
    Type.String({
      description:
        "Date for title metadata. Defaults to today (YYYY-MM-DD) when author or a cover is used.",
    })
  ),
  theme: Type.Optional(
    Type.String({
      enum: [...WORD_THEMES],
      default: "executive",
      description:
        "Visual theme: executive (deep navy), modern (indigo), minimal (near-black), " +
        "editorial (rust serif), or tech (teal).",
    })
  ),
  accent_color: Type.Optional(
    Type.String({
      description:
        "Hex accent override, e.g. '0E7490'. The generator derives a coherent, " +
        "contrast-safe palette from this color.",
    })
  ),
  font_size_pt: Type.Optional(
    Type.Number({ minimum: 8, maximum: 14, default: 11, description: "Body font size in points." })
  ),
  line_spacing: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 2,
      default: 1.15,
      description: "Line spacing multiplier.",
    })
  ),
  line_break_mode: Type.Optional(
    Type.String({
      enum: ["preserve", "commonmark"],
      default: "preserve",
      description:
        "Single-newline policy. 'preserve' (default) emits a Word line break; 'commonmark' " +
        "folds a soft break to a space. Explicit Markdown hard breaks and <br> are always preserved.",
    })
  ),
  margin_inches: Type.Optional(
    Type.Number({ minimum: 0.4, maximum: 2, default: 1, description: "Uniform page margin." })
  ),
  orientation: Type.Optional(
    Type.String({
      enum: ["portrait", "landscape"],
      default: "portrait",
      description: "Page orientation.",
    })
  ),
  page_size: Type.Optional(
    Type.String({ enum: ["letter", "a4"], default: "letter", description: "Paper size." })
  ),
  title_mode: Type.Optional(
    Type.String({
      enum: ["auto", "none", "inline", "cover"],
      default: "auto",
      description:
        "Title treatment: auto (legacy inline/cover_page behavior), none (retain a leading H1 " +
        "in the body), inline, or a standalone cover with body page numbering restarted at 1.",
    })
  ),
  cover_page: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Legacy cover-page switch. Equivalent to title_mode='cover' when title_mode is auto.",
    })
  ),
  include_toc: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Insert a Word TOC field for heading levels 1–3 and request refresh on open. Some " +
        "viewers may still require a manual field update.",
    })
  ),
  include_page_numbers: Type.Optional(
    Type.Boolean({ default: true, description: "Show page numbers in the footer." })
  ),
  header_text: Type.Optional(
    Type.String({ description: "Small muted text in the right-aligned page header." })
  ),
  footer_text: Type.Optional(
    Type.String({ description: "Small muted text in the left side of the page footer." })
  ),
  table_style: Type.Optional(
    Type.String({
      enum: ["banded", "minimal", "grid", "none"],
      default: "banded",
      description: "Table look: banded, minimal, grid, or none.",
    })
  ),
  table_layout: Type.Optional(
    Type.String({
      enum: ["content", "equal"],
      default: "content",
      description:
        "Column sizing: content-aware widths (default) or equal-width compatibility mode.",
    })
  ),
  output_path: Type.Optional(
    Type.String({
      description:
        "Destination .docx path. Relative paths resolve against the project root. When omitted, " +
        "a unique file is written under the OS temp directory (…/penny/word/).",
    })
  ),
});

export type WordGenerateParams = Static<typeof wordGenerateParams>;

export type WordGeneratorSpec = WordGenerateParams & {
  markdown_path?: string;
  output_path: string;
  project_root: string;
  staging_path?: string;
};

export function buildSpec(params: WordGenerateParams, projectRoot: string): WordGeneratorSpec {
  const hasInline = typeof params.markdown === "string" && params.markdown.trim().length > 0;
  const markdownPathInput = params.markdown_path;
  const hasFile = typeof markdownPathInput === "string" && markdownPathInput.length > 0;
  if (hasInline === hasFile) {
    throw new Error("Provide exactly one of 'markdown' or 'markdown_path'.");
  }

  let markdownPath: string | undefined;
  if (hasFile) {
    markdownPath = path.isAbsolute(markdownPathInput)
      ? markdownPathInput
      : path.join(projectRoot, markdownPathInput);
    if (!fs.existsSync(markdownPath)) {
      throw new Error(`Markdown file not found: ${markdownPath}`);
    }
  }

  const spec: WordGeneratorSpec = {
    ...params,
    markdown_path: markdownPath,
    output_path: resolveOutputPath(params.output_path, params.title, projectRoot),
    project_root: projectRoot,
  };
  if (!hasInline) delete spec.markdown;
  return spec;
}

// ── Registration ───────────────────────────────────────────────────────────

export default function wordExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    setSessionId(ctx.sessionManager.getSessionId());
  });

  registerTool(pi, {
    name: "word_generate",
    label: "Generate Word Document",
    description:
      "Render Markdown into a professionally styled, structurally validated Word (.docx) document. " +
      "Use when the requested deliverable is an editable Word document; do not use for plain-text answers or PowerPoint output. " +
      "The generator preserves intentional line breaks by default, uses inherited " +
      "Word styles and a contrast-safe palette, sizes tables by content, validates the OOXML " +
      "package, and atomically publishes the result. A leading H1 can become title matter; " +
      "title_mode='none' retains it in the body. Five themes, covers, TOCs, headers/footers, " +
      "page numbers, and local images are supported.",
    promptSnippet:
      "word_generate: render Markdown into a validated, professionally styled Word document",
    parameters: wordGenerateParams,
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "Cancelled" }],
          details: { cancelled: true },
        };
      }

      const startedAt = Date.now();
      try {
        const projectRoot = getProjectRoot();
        const spec = buildSpec(params, projectRoot);
        fs.mkdirSync(path.dirname(spec.output_path), { recursive: true });

        const outcome = await runGenerator(spec, signal);
        if (outcome.cancelled) {
          return {
            content: [{ type: "text" as const, text: "Cancelled" }],
            details: { cancelled: true },
          };
        }

        if (!outcome.result) {
          throw new Error("Word generator completed without a result");
        }
        const result = outcome.result;
        logger.info("Word document generated", {
          path: result.path,
          theme: result.theme,
          durationMs: Date.now() - startedAt,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Word generation failed", {
          error: message,
          durationMs: Date.now() - startedAt,
        });
        throw new Error(`word_generate failed: ${message}`);
      }
    },
  });

  logger.info("Word extension registered (word_generate)");
}
