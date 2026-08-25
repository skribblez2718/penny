import { registerTool } from "../../lib/pi-tool-registration.js";
/**
 * PowerPoint Extension
 *
 * Generate modern, professionally styled PowerPoint (.pptx) presentations in
 * process through the TypeScript renderer.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { createLogger, setSessionId } from "../../lib/logger/logger.js";
import { generate, type GeneratorHooks, type PowerpointGenerationResult } from "./renderer.js";

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

type PowerpointThemeName = (typeof POWERPOINT_THEMES)[number];

export interface PowerpointToolResultEnvelope extends Record<string, unknown> {
  path: string;
  slide_count: number;
  theme: PowerpointThemeName;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPowerpointThemeName(value: unknown): value is PowerpointThemeName {
  return typeof value === "string" && POWERPOINT_THEMES.some((themeName) => themeName === value);
}

function isPowerpointToolResultEnvelope(value: unknown): value is PowerpointToolResultEnvelope {
  return (
    isUnknownRecord(value) &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    typeof value.slide_count === "number" &&
    Number.isInteger(value.slide_count) &&
    value.slide_count >= 0 &&
    isPowerpointThemeName(value.theme)
  );
}

/**
 * Validate the renderer-to-Pi result boundary without closing its established
 * open envelope. Required logging fields are checked; all recorded renderer
 * fields and any future extras remain on the original object passed to Pi.
 */
export function adaptPowerpointResultEnvelope(value: unknown): PowerpointToolResultEnvelope {
  if (!value) {
    throw new Error("PowerPoint generator completed without a result");
  }
  if (!isPowerpointToolResultEnvelope(value)) {
    throw new Error("PowerPoint generator returned an invalid result envelope");
  }
  return value;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_STAGING_ATTEMPTS = 10;
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const DISCOVERED_PROJECT_ROOT = path.resolve(EXTENSION_DIR, "../../..");

// ── Path helpers (exported for unit tests) ───────────────────────────────────

export function getExtensionDir(): string {
  return EXTENSION_DIR;
}

export function getProjectRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PROJECT_ROOT?.trim();
  return configured ? path.resolve(configured) : DISCOVERED_PROJECT_ROOT;
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
  const uniq = `${String(now.getMilliseconds()).padStart(3, "0")}-${invocationId()}`;
  const name = `${slugify(title || "presentation")}_${stamp}_${time}_${uniq}.pptx`;
  return path.join(os.tmpdir(), "penny", "powerpoint", name);
}

export function resolveOutputPath(
  outputPath: string | undefined,
  title: string | undefined,
  projectRoot: string
): string {
  if (!outputPath) return defaultOutputPath(title);
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
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Unable to reserve a unique PowerPoint staging file beside ${target}`);
}

// ── Generator invocation ─────────────────────────────────────────────────────

export interface GeneratorOutcome {
  cancelled: boolean;
  result?: PowerpointGenerationResult;
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
    throw new Error("Presentation generator spec requires output_path");
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
      throw new Error(`Presentation generator timed out after ${timeoutMs}ms`);
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

export type PowerpointGenerateParams = Static<typeof powerpointGenerateParams>;

export type PowerpointGeneratorSpec = PowerpointGenerateParams & {
  output_path: string;
  project_root: string;
};

/** Build the JSON spec handed to the in-process renderer. Exported for unit tests. */
export function buildSpec(
  params: PowerpointGenerateParams,
  projectRoot: string
): PowerpointGeneratorSpec {
  const hasSlides = Array.isArray(params.slides) && params.slides.length > 0;
  const hasMarkdown = typeof params.markdown === "string" && params.markdown.trim().length > 0;
  if (hasSlides === hasMarkdown) {
    throw new Error("Provide exactly one of 'slides' or 'markdown'.");
  }
  const spec: PowerpointGeneratorSpec = {
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
  pi.on("session_start", async (_event, ctx) => {
    setSessionId(ctx.sessionManager.getSessionId());
  });

  registerTool(pi, {
    name: "powerpoint_generate",
    label: "Generate PowerPoint Presentation",
    description:
      "Render a professionally styled 16:9 PowerPoint (.pptx) presentation. Use when the requested deliverable is an editable slide deck; do not use for plain-text answers or Word documents. Preferred input is " +
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
    async execute(_toolCallId, params, signal) {
      try {
        if (signal?.aborted) {
          return {
            content: [{ type: "text" as const, text: "Cancelled" }],
            details: { cancelled: true },
          };
        }
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
        const result = adaptPowerpointResultEnvelope(outcome.result);
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
