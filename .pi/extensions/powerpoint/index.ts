/**
 * PowerPoint Extension
 *
 * Generate modern, professionally styled PowerPoint (.pptx) presentations:
 *   - powerpoint_generate: render structured slides or markdown into a themed .pptx
 *
 * The heavy lifting happens in generate_pptx.py (python-pptx + markdown-it-py),
 * run with the project venv and fed a JSON spec over stdin.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
  "image_left",
  "image_right",
  "full_bleed",
] as const;

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_STDERR_CHARS = 16_000;
const MAX_STAGING_ATTEMPTS = 10;
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const DISCOVERED_PROJECT_ROOT = path.resolve(EXTENSION_DIR, "../../..");

// ── Path helpers (exported for unit tests) ───────────────────────────────────

export function getExtensionDir(): string {
  return EXTENSION_DIR;
}

export function getGeneratorScript(): string {
  return path.join(EXTENSION_DIR, "generate_pptx.py");
}

export function getProjectRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PROJECT_ROOT?.trim();
  return configured ? path.resolve(configured) : DISCOVERED_PROJECT_ROOT;
}

export function venvPythonCandidates(
  root: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  const unix = path.join(root, ".venv", "bin", "python");
  const windows = path.join(root, ".venv", "Scripts", "python.exe");
  return platform === "win32" ? [windows, unix] : [unix, windows];
}

export function getVenvPython(
  root = getProjectRoot(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const override = env.PI_VENV_PYTHON?.trim();
  if (override) return path.resolve(override);
  const candidates = venvPythonCandidates(root, platform);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
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
export function defaultOutputPath(
  title: string | undefined,
  now: Date = new Date(),
  invocationId: () => string = randomUUID
): string {
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
  // A full invocation UUID prevents concurrent sibling calls from deriving the
  // same final destination; staging already receives a separate UUID below.
  const uniq = `${String(now.getMilliseconds()).padStart(3, "0")}-${invocationId()}`;
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

/** Reserve a parent-owned same-directory staging path for one invocation. */
export function reserveStagingPath(outputPath: string): string {
  const target = path.resolve(outputPath);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  for (let attempt = 0; attempt < MAX_STAGING_ATTEMPTS; attempt += 1) {
    const candidate = path.join(
      directory,
      `.${path.basename(target, ".pptx")}.${randomUUID()}.tmp.pptx`
    );
    try {
      const descriptor = fs.openSync(candidate, "wx", 0o600);
      fs.closeSync(descriptor);
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Unable to reserve a unique PowerPoint staging file beside ${target}`);
}

// ── Generator invocation ─────────────────────────────────────────────────────

export interface GeneratorOutcome {
  cancelled: boolean;
  result?: Record<string, unknown>;
}

export interface GeneratorRunOptions {
  pythonPath?: string;
  timeoutMs?: number;
}

function generatorTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PENNY_DOCGEN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function boundedAppend(current: string, chunk: Buffer, limit: number): string {
  const appended = current + chunk.toString();
  return appended.length <= limit ? appended : appended.slice(-limit);
}

export function runGenerator(
  scriptPath: string,
  spec: Record<string, unknown>,
  signal: AbortSignal | undefined,
  options: GeneratorRunOptions = {}
): Promise<GeneratorOutcome> {
  if (signal?.aborted) return Promise.resolve({ cancelled: true });

  const projectRoot = getProjectRoot();
  const configuredOverride = process.env.PI_VENV_PYTHON?.trim();
  const attempted = options.pythonPath
    ? [path.resolve(options.pythonPath)]
    : configuredOverride
      ? [path.resolve(configuredOverride)]
      : venvPythonCandidates(projectRoot);
  const python = options.pythonPath ? path.resolve(options.pythonPath) : getVenvPython(projectRoot);

  if (!fs.existsSync(python)) {
    throw new Error(
      `Python interpreter not found. Attempted: ${attempted.join(", ")}. ` +
        "Run `uv sync --extra dev --frozen` or set PI_VENV_PYTHON."
    );
  }
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`PowerPoint generator script not found: ${scriptPath}`);
  }

  const outputPath = spec.output_path;
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new Error("Presentation generator spec requires output_path");
  }
  const stagingPath = reserveStagingPath(outputPath);
  const preparedSpec = { ...spec, staging_path: stagingPath };
  const timeoutMs = options.timeoutMs ?? generatorTimeoutMs();

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const proc = spawn(python, [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    let timedOut = false;
    let settled = false;
    const lifecycle: { timer?: ReturnType<typeof setTimeout> } = {};

    const cleanup = () => {
      if (lifecycle.timer !== undefined) clearTimeout(lifecycle.timer);
      signal?.removeEventListener("abort", onAbort);
      fs.rmSync(stagingPath, { force: true });
    };
    const settleResolve = (outcome: GeneratorOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onAbort = () => {
      aborted = true;
      if (!proc.kill("SIGKILL")) settleResolve({ cancelled: true });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    lifecycle.timer = setTimeout(() => {
      timedOut = true;
      if (!proc.kill("SIGKILL")) {
        settleReject(new Error(`Presentation generator timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr = boundedAppend(stderr, data, MAX_STDERR_CHARS);
    });

    proc.on("close", (code) => {
      const durationMs = Date.now() - startedAt;
      if (timedOut) {
        settleReject(
          new Error(
            `Presentation generator timed out after ${timeoutMs}ms ` +
              `(python=${python}, script=${scriptPath}, durationMs=${durationMs})`
          )
        );
        return;
      }
      if (aborted) {
        settleResolve({ cancelled: true });
        return;
      }
      if (code !== 0) {
        const diagnostic = stderr.trim() || `Presentation generator exited with code ${code}`;
        settleReject(
          new Error(
            `${diagnostic}\n` +
              `(python=${python}, script=${scriptPath}, exitCode=${String(code)}, durationMs=${durationMs})`
          )
        );
        return;
      }
      try {
        settleResolve({
          cancelled: false,
          result: JSON.parse(stdout) as Record<string, unknown>,
        });
      } catch {
        settleReject(
          new Error(
            `Presentation generator returned invalid JSON: ${stdout.slice(0, 500)} ` +
              `(python=${python}, script=${scriptPath}, durationMs=${durationMs})`
          )
        );
      }
    });

    proc.on("error", (error) => {
      settleReject(
        new Error(
          `Unable to start presentation generator: ${error.message} ` +
            `(python=${python}, script=${scriptPath})`
        )
      );
    });

    proc.stdin.on("error", () => {});
    proc.stdin.write(JSON.stringify(preparedSpec));
    proc.stdin.end();
  });
}

// ── Tool parameters ──────────────────────────────────────────────────────────

export const HexColor = Type.String({
  pattern: "^#?[0-9A-Fa-f]{6}$",
  description: "Six-digit hexadecimal color, with an optional leading '#'.",
});

export const Fit = Type.Union([Type.Literal("crop"), Type.Literal("contain")], {
  description: "Aspect-preserving crop or contain fit.",
});

export const FocalPoint = Type.Object(
  {
    x: Type.Number({ minimum: 0, maximum: 1, description: "Normalized horizontal position." }),
    y: Type.Number({ minimum: 0, maximum: 1, description: "Normalized vertical position." }),
  },
  { additionalProperties: false }
);

export const Overlay = Type.Object(
  {
    color: Type.Optional(HexColor),
    opacity: Type.Number({
      minimum: 0,
      maximum: 1,
      description: "Overlay opacity from 0 (transparent) to 1 (opaque).",
    }),
  },
  { additionalProperties: false }
);

export const MediaSpec = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description: "Local static PNG/JPEG path, absolute or relative to the project root.",
    }),
    fit: Type.Optional(Fit),
    focal_point: Type.Optional(FocalPoint),
    overlay: Type.Optional(Overlay),
  },
  {
    additionalProperties: false,
    description:
      "Local background or composed media. Fit defaults to crop for backgrounds/full_bleed and contain for side layouts.",
  }
);

export const PalettePatch = Type.Object(
  {
    canvas: Type.Optional(HexColor),
    surface: Type.Optional(HexColor),
    accent: Type.Optional(HexColor),
    text: Type.Optional(HexColor),
    muted_text: Type.Optional(HexColor),
  },
  {
    additionalProperties: false,
    description: "Semantic palette patch; requested text roles may be contrast-corrected.",
  }
);

export const PlacedImage = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description: "Local static PNG/JPEG path, absolute or relative to the project root.",
    }),
    x: Type.Number({ minimum: 0, maximum: 1, description: "Normalized left edge." }),
    y: Type.Number({ minimum: 0, maximum: 1, description: "Normalized top edge." }),
    width: Type.Number({
      exclusiveMinimum: 0,
      maximum: 1,
      description: "Normalized width greater than zero.",
    }),
    height: Type.Number({
      exclusiveMinimum: 0,
      maximum: 1,
      description: "Normalized height greater than zero.",
    }),
    fit: Type.Optional(Fit),
    focal_point: Type.Optional(FocalPoint),
  },
  {
    additionalProperties: false,
    description: "One normalized placed mark; fit defaults to contain.",
  }
);

export const DeckDesign = Type.Object(
  {
    palette: Type.Optional(PalettePatch),
    background: Type.Optional(MediaSpec),
    mark: Type.Optional(PlacedImage),
  },
  {
    additionalProperties: false,
    description: "Deck design defaults: palette, local background, and one mark.",
  }
);

export const SlideDesign = Type.Object(
  {
    palette: Type.Optional(PalettePatch),
    background: Type.Optional(Type.Union([MediaSpec, Type.Null()])),
    mark: Type.Optional(Type.Union([PlacedImage, Type.Null()])),
  },
  {
    additionalProperties: false,
    description:
      "Per-slide design patch: palette merges, objects replace, and null removes inherited background/mark.",
  }
);

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
      "(full-accent thank-you), or structured-only 'image_left', 'image_right', and " +
      "'full_bleed' composed-media layouts.",
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
  design: Type.Optional(SlideDesign),
  media: Type.Optional(MediaSpec),
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
        "an image slide; content is split into continuation slides by conservative height " +
        "estimation so table rows, code lines, paragraphs, and bullet items are never truncated.",
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
  accent_color: Type.Optional(HexColor),
  design: Type.Optional(DeckDesign),
  allowed_image_roots: Type.Optional(
    Type.Array(
      Type.String({ minLength: 1, description: "Additional canonical root for new image assets." }),
      {
        minItems: 1,
        description:
          "Additional allowed roots for design/background/media/mark assets; project_root is always allowed.",
      }
    )
  ),
  line_break_mode: Type.Optional(
    Type.String({
      enum: ["preserve", "commonmark"],
      default: "preserve",
      description:
        "Single-newline policy. 'preserve' (default) emits a PowerPoint line break; " +
        "'commonmark' folds a soft break to a space. Hard breaks and <br> are always preserved.",
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
  design?: Record<string, unknown>;
  allowed_image_roots?: string[];
  line_break_mode?: "preserve" | "commonmark";
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
      "quote, image (auto-fit with caption), closing, image_left, image_right, and full_bleed. " +
      "The additive design API supports semantic light or dark palettes, a local background, " +
      "one mark, and local composed media while keeping text editable. Alternatively pass " +
      "'markdown' for convenience (see the parameter description for the exact slide-splitting " +
      "rules); Markdown classification is unchanged. Five built-in themes " +
      "(executive/modern/minimal/editorial/tech) remain legacy seeds. Speaker notes, footer " +
      "text, and slide numbers are supported. Content is conservatively paginated without " +
      "truncating table rows or code lines, resolved text roles meet 4.5:1 contrast against " +
      "their opaque surfaces, and every deck is structurally validated before atomic publication. " +
      "When output_path is omitted, output is written to the OS temp dir " +
      "(…/penny/powerpoint/).",
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
      try {
        if (signal?.aborted) {
          return {
            content: [{ type: "text" as const, text: "Cancelled" }],
            details: { cancelled: true },
          };
        }
        const projectRoot = getProjectRoot();
        const spec = buildSpec(params, projectRoot);
        fs.mkdirSync(path.dirname(spec.output_path as string), { recursive: true });
        const outcome = await runGenerator(getGeneratorScript(), spec, signal);
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
