/**
 * PowerPoint Extension
 *
 * Generate modern, professionally styled PowerPoint (.pptx) presentations:
 *   - powerpoint_generate: render structured slides or markdown into a themed .pptx
 *
 * The heavy lifting happens in generate_pptx.py (python-pptx + markdown-it-py),
 * run with the project venv and fed a JSON spec over stdin.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createLogger, setSessionId } from "../../lib/logger/logger.js";

const logger = createLogger("powerpoint");

export const POWERPOINT_THEMES = ["executive", "modern", "minimal", "editorial", "tech"] as const;
export const SLIDE_LAYOUTS = [
  "title",
  "section",
  "content",
  "two_column",
  "table",
  "quote",
  "image",
  "closing",
] as const;

const DEFAULT_TIMEOUT_MS = 90_000;

// ── Path helpers (exported for unit tests) ───────────────────────────────────

export function getProjectRoot(): string {
  return process.env.PROJECT_ROOT || process.cwd();
}

export function getVenvPython(): string {
  return process.env.PI_VENV_PYTHON || path.join(getProjectRoot(), ".venv", "bin", "python");
}

/** Lowercase, alphanumeric-and-dash slug for filenames; never empty. */
export function slugify(input: string, fallback = "presentation"): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || fallback;
}

/** Default output path when the caller gives none: a per-run temp file under the
 *  OS temp dir (…/penny/powerpoint/) — never the project tree. */
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
  const name = `${slugify(title || "presentation")}_${stamp}_${time}_${uniq}.pptx`;
  return path.join(os.tmpdir(), "penny", "powerpoint", name);
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
  return resolved.toLowerCase().endsWith(".pptx") ? resolved : `${resolved}.pptx`;
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
      reject(new Error(`Presentation generator timed out after ${generatorTimeoutMs()}ms`));
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
        reject(new Error(stderr.trim() || `Presentation generator exited with code ${code}`));
        return;
      }
      try {
        resolve({ cancelled: false, result: JSON.parse(stdout) });
      } catch {
        reject(new Error(`Presentation generator returned invalid JSON: ${stdout.slice(0, 500)}`));
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

const bulletItem = Type.Union([
  Type.String({ description: "Plain bullet text (inline **bold**/*italic*/`code` supported)." }),
  Type.Object({
    text: Type.String({ description: "Bullet text." }),
    level: Type.Optional(
      Type.Number({ minimum: 0, maximum: 2, description: "Nesting level 0–2 (default 0)." })
    ),
    bold: Type.Optional(Type.Boolean({ description: "Render the whole bullet bold." })),
  }),
]);

const columnSpec = Type.Object({
  heading: Type.Optional(Type.String({ description: "Accent-colored column heading." })),
  body: Type.Optional(Type.String({ description: "Paragraph text above the column bullets." })),
  bullets: Type.Optional(Type.Array(bulletItem)),
});

const slideSpec = Type.Object({
  layout: Type.String({
    enum: [...SLIDE_LAYOUTS],
    description:
      "Slide layout: 'title' (opening), 'section' (full-accent divider), 'content' " +
      "(title + body/bullets), 'two_column', 'table', 'quote', 'image', 'closing' " +
      "(full-accent thank-you).",
  }),
  title: Type.Optional(Type.String({ description: "Slide title." })),
  subtitle: Type.Optional(Type.String({ description: "Subtitle (title/closing layouts)." })),
  kicker: Type.Optional(
    Type.String({ description: "Small uppercase accent label above the title (content layouts)." })
  ),
  body: Type.Optional(
    Type.String({ description: "Paragraph text rendered before bullets (content layout)." })
  ),
  bullets: Type.Optional(Type.Array(bulletItem, { description: "Bullet list items." })),
  left: Type.Optional(columnSpec),
  right: Type.Optional(columnSpec),
  table: Type.Optional(
    Type.Object({
      headers: Type.Array(Type.String()),
      rows: Type.Array(Type.Array(Type.String())),
    })
  ),
  quote: Type.Optional(Type.String({ description: "Quote text (quote layout)." })),
  attribution: Type.Optional(Type.String({ description: "Quote attribution, without the dash." })),
  image_path: Type.Optional(
    Type.String({ description: "Image file path (absolute or relative to the project root)." })
  ),
  caption: Type.Optional(Type.String({ description: "Muted caption under the image." })),
  author: Type.Optional(Type.String({ description: "Author on the title slide meta line." })),
  date: Type.Optional(Type.String({ description: "Date on the title slide meta line." })),
  notes: Type.Optional(Type.String({ description: "Speaker notes for this slide." })),
});

const powerpointGenerateParams = Type.Object({
  slides: Type.Optional(
    Type.Array(slideSpec, {
      description:
        "Structured slide list (preferred for full control). Exactly one of 'slides' or " +
        "'markdown' is required.",
    })
  ),
  markdown: Type.Optional(
    Type.String({
      description:
        "Markdown convenience mode. Rules: a leading '# H1' (+ following paragraph) becomes " +
        "the title slide; '---' immediately before a '## H2' makes that H2 a section divider, " +
        "otherwise each '## H2' starts a new content slide; paragraphs become body text, lists " +
        "become bullets (nesting capped at 2), '### H3' becomes a bold bullet, fenced code " +
        "renders as a shaded code panel, a table becomes a table slide, a blockquote becomes " +
        "a quote slide (trailing '— name' line becomes the attribution), each image becomes " +
        "an image slide; mixed content under one heading splits into consecutive slides so " +
        "nothing is dropped, and slides with more than 7 bullets split into '(cont.)' slides.",
    })
  ),
  title: Type.Optional(
    Type.String({
      description: "Deck title — used for an auto title slide in markdown mode and the filename.",
    })
  ),
  subtitle: Type.Optional(Type.String({ description: "Fallback subtitle for the title slide." })),
  author: Type.Optional(Type.String({ description: "Author on the title slide meta line." })),
  date: Type.Optional(Type.String({ description: "Date on the title slide meta line." })),
  theme: Type.Optional(
    Type.String({
      enum: [...POWERPOINT_THEMES],
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
  footer_text: Type.Optional(
    Type.String({ description: "Muted footer text, bottom-left of content slides." })
  ),
  slide_numbers: Type.Optional(
    Type.Boolean({
      default: true,
      description: "Slide numbers bottom-right (skipped on title/section/closing slides).",
    })
  ),
  output_path: Type.Optional(
    Type.String({
      description:
        "Destination .pptx path. When omitted, writes to a temp file under the OS temp dir (…/penny/powerpoint/) — not the project tree. " +
        "Relative paths resolve against the project root.",
    })
  ),
});

interface PowerpointGenerateParams {
  slides?: unknown[];
  markdown?: string;
  title?: string;
  subtitle?: string;
  author?: string;
  date?: string;
  theme?: string;
  accent_color?: string;
  footer_text?: string;
  slide_numbers?: boolean;
  output_path?: string;
}

/** Build the JSON spec handed to generate_pptx.py. Exported for unit tests. */
export function buildSpec(
  params: PowerpointGenerateParams,
  projectRoot: string
): Record<string, unknown> {
  const hasSlides = Array.isArray(params.slides) && params.slides.length > 0;
  const hasMarkdown = typeof params.markdown === "string" && params.markdown.trim().length > 0;
  if (hasSlides === hasMarkdown) {
    throw new Error("Provide exactly one of 'slides' or 'markdown'.");
  }
  const spec: Record<string, unknown> = {
    ...params,
    output_path: resolveOutputPath(params.output_path, params.title, projectRoot),
    project_root: projectRoot,
  };
  // Drop the inactive input (e.g. whitespace-only markdown alongside slides) so the
  // generator's own exactly-one-input check agrees with the gate above.
  if (!hasMarkdown) {
    delete spec.markdown;
  }
  if (!hasSlides) {
    delete spec.slides;
  }
  return spec;
}

// ── Registration ─────────────────────────────────────────────────────────────

export default function powerpointExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event: unknown, ctx: unknown) => {
    const sessionCtx = ctx as { sessionManager: { getSessionId(): string } };
    setSessionId(sessionCtx.sessionManager.getSessionId());
  });

  pi.registerTool({
    name: "powerpoint_generate",
    label: "Generate PowerPoint Presentation",
    description:
      "Render a professionally styled 16:9 PowerPoint (.pptx) presentation. Preferred input is " +
      "a structured 'slides' array with layouts: title, section (full-accent divider), content " +
      "(kicker/title/body/bullets with nesting), two_column, table (accent header, banded rows), " +
      "quote, image (auto-fit with caption), and closing. Alternatively pass 'markdown' for " +
      "convenience (see the parameter description for the exact slide-splitting rules). Five " +
      "built-in themes (executive/modern/minimal/editorial/tech) control fonts and accent " +
      "colors; speaker notes, footer text, and slide numbers are supported. When output_path is " +
      "omitted, output is written to the OS temp dir (…/penny/powerpoint/).",
    promptSnippet:
      "powerpoint_generate: render structured slides or markdown into a professionally styled PowerPoint (.pptx)",
    parameters: powerpointGenerateParams,
    async execute(
      _toolCallId: string,
      params: PowerpointGenerateParams,
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

      const script = path.join(projectRoot, ".pi", "extensions", "powerpoint", "generate_pptx.py");
      try {
        const outcome = await runGenerator(script, spec, signal);
        if (outcome.cancelled) {
          return {
            content: [{ type: "text" as const, text: "Cancelled" }],
            details: { cancelled: true },
          };
        }
        const result = outcome.result as Record<string, unknown>;
        logger.info("PowerPoint generated", {
          path: result.path,
          slides: result.slide_count,
          theme: result.theme,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("PowerPoint generation failed", { error: message });
        throw new Error(`powerpoint_generate failed: ${message}`);
      }
    },
  });

  logger.info("PowerPoint extension registered (powerpoint_generate)");
}
