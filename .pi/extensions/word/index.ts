/**
 * Word Extension
 *
 * Generate modern, professionally styled Word (.docx) documents from markdown:
 *   - word_generate: render markdown (inline or from a file) into a themed .docx
 *
 * The heavy lifting happens in generate_docx.py (python-docx + markdown-it-py),
 * run with the project venv and fed a JSON spec over stdin.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createLogger, setSessionId } from "../../lib/logger/logger.js";

const logger = createLogger("word");

export const WORD_THEMES = ["executive", "modern", "minimal", "editorial", "tech"] as const;

const DEFAULT_TIMEOUT_MS = 90_000;

// ── Path helpers (exported for unit tests) ───────────────────────────────────

export function getProjectRoot(): string {
  return process.env.PROJECT_ROOT || process.cwd();
}

export function getVenvPython(): string {
  return process.env.PI_VENV_PYTHON || path.join(getProjectRoot(), ".venv", "bin", "python");
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

/** Default output path when the caller gives none: a per-run temp file under the
 *  OS temp dir (…/penny/word/) — never the project tree. */
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
  // Millisecond + random suffix: sibling tool calls run concurrently in pi, so a
  // 1-second timestamp alone can collide and silently overwrite a sibling's output.
  const uniq = `${String(now.getMilliseconds()).padStart(3, "0")}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const name = `${slugify(title || "document")}_${stamp}_${time}_${uniq}.docx`;
  return path.join(os.tmpdir(), "penny", "word", name);
}

/** Resolve the final output path from an optional explicit param. */
export function resolveOutputPath(
  outputPath: string | undefined,
  title: string | undefined,
  projectRoot: string
): string {
  if (!outputPath) {
    return defaultOutputPath(title);
  }
  const resolved = path.isAbsolute(outputPath) ? outputPath : path.join(projectRoot, outputPath);
  return resolved.toLowerCase().endsWith(".docx") ? resolved : `${resolved}.docx`;
}

// ── Generator invocation ─────────────────────────────────────────────────────

interface GeneratorOutcome {
  cancelled: boolean;
  result?: Record<string, unknown>;
}

function generatorTimeoutMs(): number {
  const raw = Number(process.env.PENNY_DOCGEN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function runGenerator(
  scriptPath: string,
  spec: Record<string, unknown>,
  signal: AbortSignal | undefined
): Promise<GeneratorOutcome> {
  const python = getVenvPython();
  if (!fs.existsSync(python)) {
    throw new Error(
      `Python venv not found at ${python}. Run scripts/setup/init-external-tools.sh (or make setup) first.`
    );
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(python, [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let aborted = false;

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Document generator timed out after ${generatorTimeoutMs()}ms`));
    }, generatorTimeoutMs());

    const onAbort = () => {
      aborted = true;
      proc.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (aborted) {
        resolve({ cancelled: true });
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Document generator exited with code ${code}`));
        return;
      }
      try {
        resolve({ cancelled: false, result: JSON.parse(stdout) });
      } catch {
        reject(new Error(`Document generator returned invalid JSON: ${stdout.slice(0, 500)}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    // If the child dies before draining stdin (broken venv, abort/timeout SIGKILL),
    // the pending write fails with EPIPE. Without this listener that surfaces as an
    // unhandled 'error' event on the Socket and kills the whole pi process; the
    // 'close' handler above already settles the promise with the real failure.
    proc.stdin.on("error", () => {});

    proc.stdin.write(JSON.stringify(spec));
    proc.stdin.end();
  });
}

// ── Tool parameters ──────────────────────────────────────────────────────────

const wordGenerateParams = Type.Object({
  markdown: Type.Optional(
    Type.String({
      description:
        "Full markdown content to render. Supports headings H1–H6, paragraphs, **bold**, " +
        "*italic*, `inline code`, ~~strikethrough~~, [links](url), nested bullet and numbered " +
        "lists, tables, fenced code blocks, blockquotes, horizontal rules, and images " +
        "(![caption](path) — absolute path or relative to the project root). Exactly one of " +
        "'markdown' or 'markdown_path' is required.",
    })
  ),
  markdown_path: Type.Optional(
    Type.String({
      description:
        "Path to a markdown file to render instead of inline 'markdown'. Relative paths " +
        "resolve against the project root.",
    })
  ),
  title: Type.Optional(
    Type.String({
      description:
        "Document title. Defaults to the first H1 in the markdown (which is then not " +
        "repeated in the body), else 'Document'.",
    })
  ),
  subtitle: Type.Optional(
    Type.String({ description: "Subtitle rendered under the title in muted text." })
  ),
  author: Type.Optional(
    Type.String({ description: "Author shown on the title block / cover page meta line." })
  ),
  date: Type.Optional(
    Type.String({
      description:
        "Date for the meta line. Defaults to today (YYYY-MM-DD) when author or cover_page is set.",
    })
  ),
  theme: Type.Optional(
    Type.String({
      enum: [...WORD_THEMES],
      description:
        "Visual theme: 'executive' (deep navy, Calibri — default), 'modern' (indigo, Segoe UI), " +
        "'minimal' (near-black, Arial), 'editorial' (rust, Georgia serif), 'tech' (teal, Segoe UI).",
      default: "executive",
    })
  ),
  accent_color: Type.Optional(
    Type.String({
      description: "Hex accent color override for the theme, e.g. '0E7490' ('#' optional).",
    })
  ),
  font_size_pt: Type.Optional(
    Type.Number({ minimum: 8, maximum: 14, default: 11, description: "Body font size in points." })
  ),
  line_spacing: Type.Optional(
    Type.Number({
      minimum: 1.0,
      maximum: 2.0,
      default: 1.15,
      description: "Line spacing multiplier.",
    })
  ),
  margin_inches: Type.Optional(
    Type.Number({ minimum: 0.4, maximum: 2.0, default: 1.0, description: "Uniform page margin." })
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
  cover_page: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Render a standalone cover page (accent bar, large title, author/date), then a page break.",
    })
  ),
  include_toc: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Insert a Table of Contents (heading levels 1–3) before the body.",
    })
  ),
  include_page_numbers: Type.Optional(
    Type.Boolean({ default: true, description: "Show page numbers in the footer." })
  ),
  header_text: Type.Optional(
    Type.String({ description: "Small muted text in the page header (right-aligned)." })
  ),
  footer_text: Type.Optional(
    Type.String({ description: "Small muted text in the page footer (left-aligned)." })
  ),
  table_style: Type.Optional(
    Type.String({
      enum: ["banded", "minimal", "grid", "none"],
      default: "banded",
      description:
        "Table look: 'banded' (accent header, alternating row fill — default), 'minimal' " +
        "(accent underline below header only), 'grid' (all hairline borders), 'none'.",
    })
  ),
  output_path: Type.Optional(
    Type.String({
      description:
        "Destination .docx path. When omitted, writes to a temp file under the OS temp dir (…/penny/word/) — not the project tree. " +
        "Relative paths resolve against the project root.",
    })
  ),
});

interface WordGenerateParams {
  markdown?: string;
  markdown_path?: string;
  title?: string;
  subtitle?: string;
  author?: string;
  date?: string;
  theme?: string;
  accent_color?: string;
  font_size_pt?: number;
  line_spacing?: number;
  margin_inches?: number;
  orientation?: string;
  page_size?: string;
  cover_page?: boolean;
  include_toc?: boolean;
  include_page_numbers?: boolean;
  header_text?: string;
  footer_text?: string;
  table_style?: string;
  output_path?: string;
}

/** Build the JSON spec handed to generate_docx.py. Exported for unit tests. */
export function buildSpec(
  params: WordGenerateParams,
  projectRoot: string
): Record<string, unknown> {
  const hasInline = typeof params.markdown === "string" && params.markdown.trim().length > 0;
  const hasFile = typeof params.markdown_path === "string" && params.markdown_path.length > 0;
  if (hasInline === hasFile) {
    throw new Error("Provide exactly one of 'markdown' or 'markdown_path'.");
  }
  let markdownPath: string | undefined;
  if (hasFile) {
    markdownPath = path.isAbsolute(params.markdown_path as string)
      ? (params.markdown_path as string)
      : path.join(projectRoot, params.markdown_path as string);
    if (!fs.existsSync(markdownPath)) {
      throw new Error(`Markdown file not found: ${markdownPath}`);
    }
  }
  const spec: Record<string, unknown> = {
    ...params,
    markdown_path: markdownPath,
    output_path: resolveOutputPath(params.output_path, params.title, projectRoot),
    project_root: projectRoot,
  };
  if (!hasInline) {
    // Drop e.g. whitespace-only markdown so the generator's own
    // exactly-one-input check agrees with the gate above.
    delete spec.markdown;
  }
  return spec;
}

// ── Registration ─────────────────────────────────────────────────────────────

export default function wordExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event: unknown, ctx: unknown) => {
    const sessionCtx = ctx as { sessionManager: { getSessionId(): string } };
    setSessionId(sessionCtx.sessionManager.getSessionId());
  });

  pi.registerTool({
    name: "word_generate",
    label: "Generate Word Document",
    description:
      "Render markdown into a professionally styled Word (.docx) document. Compose the full " +
      "document content as markdown (any content type: reports, proposals, guides, memos, " +
      "resumes) and pass it inline via 'markdown', or point at a file with 'markdown_path'. " +
      "Supports CommonMark plus tables and strikethrough; a leading H1 becomes the document " +
      "title automatically. Five built-in themes (executive/modern/minimal/editorial/tech) " +
      "control fonts and accent colors; optional cover page, table of contents, headers/footers, " +
      "and page numbers. When output_path is omitted, output is written to the OS temp dir (…/penny/word/).",
    promptSnippet:
      "word_generate: render markdown into a professionally styled Word (.docx) document",
    parameters: wordGenerateParams,
    async execute(
      _toolCallId: string,
      params: WordGenerateParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown
    ) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "Cancelled" }],
          details: { cancelled: true },
        };
      }
      const projectRoot = getProjectRoot();
      const spec = buildSpec(params, projectRoot);
      fs.mkdirSync(path.dirname(spec.output_path as string), { recursive: true });

      const script = path.join(projectRoot, ".pi", "extensions", "word", "generate_docx.py");
      try {
        const outcome = await runGenerator(script, spec, signal);
        if (outcome.cancelled) {
          return {
            content: [{ type: "text" as const, text: "Cancelled" }],
            details: { cancelled: true },
          };
        }
        const result = outcome.result as Record<string, unknown>;
        logger.info("Word document generated", { path: result.path, theme: result.theme });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("Word generation failed", { error: message });
        throw new Error(`word_generate failed: ${message}`);
      }
    },
  });

  logger.info("Word extension registered (word_generate)");
}
