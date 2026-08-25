import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  Header,
  ImageRun,
  LineRuleType,
  Packer,
  PageBreak,
  PageNumber,
  PageOrientation,
  Paragraph,
  patchDetector,
  SectionType,
  TabStopType,
  Table,
  TableCell,
  TableLayoutType,
  TableOfContents,
  TableRow,
  TextRun,
  VerticalAlignTable,
  WidthType,
  convertInchesToTwip,
} from "docx";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { imageSize } from "image-size";
import JSZip from "jszip";
import MarkdownIt from "markdown-it";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface Theme {
  accent: string;
  text_dark: string;
  text_muted: string;
  heading_font: string;
  body_font: string;
  mono_font: string;
}

export interface ColorTokens {
  text: string;
  text_muted: string;
  heading: string;
  accent: string;
  accent_soft: string;
  on_accent: string;
  link: string;
  link_on_accent: string;
  background: string;
  surface: string;
  surface_alt: string;
  border: string;
  code_background: string;
}

export interface TypeScale {
  title: number;
  cover_title: number;
  subtitle: number;
  h1: number;
  h2: number;
  h3: number;
  h4: number;
  h5: number;
  h6: number;
  body: number;
  table: number;
  caption: number;
  code: number;
  header_footer: number;
}

export interface Options {
  title: string | null;
  subtitle: string | null;
  author: string | null;
  date: string | null;
  theme_name: ThemeName;
  theme: Theme;
  colors: ColorTokens;
  scale: TypeScale;
  font_size_pt: number;
  line_spacing: number;
  line_break_mode: "preserve" | "commonmark";
  margin_inches: number;
  orientation: "portrait" | "landscape";
  page_size: "letter" | "a4";
  title_mode: "none" | "inline" | "cover";
  include_toc: boolean;
  include_page_numbers: boolean;
  header_text: string | null;
  footer_text: string | null;
  table_style: "banded" | "minimal" | "grid" | "none";
  table_layout: "content" | "equal";
  output_path: string;
  staging_path: string | null;
  project_root: string;
}

export interface ValidationResult {
  package_valid: true;
  reopen_valid: true;
  required_parts: string[];
  xml_parts_checked: number;
}

export interface WordGenerationResult {
  path: string;
  title: string;
  theme: ThemeName;
  words: number;
  headings: number;
  tables: number;
  code_blocks: number;
  images: number;
  warnings: string[];
  validation: ValidationResult;
  normalization: {
    line_break_mode: Options["line_break_mode"];
    title_mode: Options["title_mode"];
    table_layout: Options["table_layout"];
    leading_h1_consumed: boolean;
  };
  resolved_palette: ColorTokens;
  toc_field_update_requested: boolean;
}

export interface GeneratorHooks {
  before_render?: (signal: AbortSignal | undefined) => Promise<void> | void;
  before_pack?: (signal: AbortSignal | undefined) => Promise<void> | void;
  before_publish?: (signal: AbortSignal | undefined) => Promise<void> | void;
}

interface Stats {
  headings: number;
  tables: number;
  code_blocks: number;
  images: number;
}

export interface MarkdownToken {
  type: string;
  tag: string;
  content: string;
  children?: MarkdownToken[] | null;
  attrs?: unknown;
  attrGet?: (name: string) => string | null;
  info?: string;
}

interface RunProfile {
  link_style: string;
  code_style: string;
  italic: boolean;
}

interface InlineState {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  in_link: boolean;
}

interface TableCellSpec {
  children: MarkdownToken[];
  alignment: "left" | "center" | "right" | null;
}

export const THEMES = {
  executive: {
    accent: "1F3A5F",
    text_dark: "1F2937",
    text_muted: "6B7280",
    heading_font: "Calibri Light",
    body_font: "Calibri",
    mono_font: "Consolas",
  },
  modern: {
    accent: "4F46E5",
    text_dark: "111827",
    text_muted: "6B7280",
    heading_font: "Segoe UI",
    body_font: "Segoe UI",
    mono_font: "Consolas",
  },
  minimal: {
    accent: "111827",
    text_dark: "111827",
    text_muted: "6B7280",
    heading_font: "Arial",
    body_font: "Arial",
    mono_font: "Consolas",
  },
  editorial: {
    accent: "7C2D12",
    text_dark: "1F2937",
    text_muted: "6B7280",
    heading_font: "Georgia",
    body_font: "Georgia",
    mono_font: "Consolas",
  },
  tech: {
    accent: "0F766E",
    text_dark: "111827",
    text_muted: "6B7280",
    heading_font: "Segoe UI",
    body_font: "Calibri",
    mono_font: "Consolas",
  },
} as const satisfies Record<string, Theme>;

export type ThemeName = keyof typeof THEMES;

export const PAGE_SIZES = {
  letter: { width: 8.5, height: 11.0 },
  a4: { width: 8.27, height: 11.69 },
} as const;

const WHITE = "FFFFFF";
const BLACK = "000000";
const HEX_RE = /^[0-9A-Fa-f]{6}$/;
const BR_TAG_RE = /^<br\s*\/?>$/i;
const REQUIRED_DOCX_PARTS = ["[Content_Types].xml", "_rels/.rels", "word/document.xml"] as const;
const MAX_STAGING_ATTEMPTS = 10;
const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: false,
});

export const PENNY_BODY = "PennyBody";
export const PENNY_QUOTE = "PennyQuote";
export const PENNY_TABLE_HEADER = "PennyTableHeader";
export const PENNY_TABLE_HEADER_ACCENT = "PennyTableHeaderOnAccent";
export const PENNY_TABLE_BODY = "PennyTableBody";
export const PENNY_CAPTION = "PennyCaption";
export const PENNY_CODE_BLOCK = "PennyCodeBlock";
export const PENNY_LIST_CONTINUE = "PennyListContinue";
export const PENNY_DOCUMENT_TITLE = "PennyDocumentTitle";
export const PENNY_COVER_TITLE = "PennyCoverTitle";
export const PENNY_SUBTITLE = "PennySubtitle";
export const PENNY_METADATA = "PennyMetadata";
export const PENNY_HEADER_FOOTER = "PennyHeaderFooter";
export const PENNY_HYPERLINK = "PennyHyperlink";
export const PENNY_HYPERLINK_ACCENT = "PennyHyperlinkOnAccent";
export const PENNY_INLINE_CODE = "PennyInlineCode";
export const PENNY_INLINE_CODE_ACCENT = "PennyInlineCodeOnAccent";

const DEFAULT_RUN_PROFILE: RunProfile = {
  link_style: PENNY_HYPERLINK,
  code_style: PENNY_INLINE_CODE,
  italic: false,
};

const HEADING_LEVELS: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

class CancellationError extends Error {
  constructor(message = "Cancelled") {
    super(message);
    this.name = "AbortError";
  }
}

export class DocumentGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentGenerationError";
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isMarkdownToken(value: unknown): value is MarkdownToken {
  if (
    !isUnknownRecord(value) ||
    typeof value.type !== "string" ||
    typeof value.tag !== "string" ||
    typeof value.content !== "string"
  ) {
    return false;
  }
  if (
    value.children !== undefined &&
    value.children !== null &&
    (!isUnknownArray(value.children) || !value.children.every(isMarkdownToken))
  ) {
    return false;
  }
  if (value.attrGet !== undefined && typeof value.attrGet !== "function") return false;
  return value.info === undefined || typeof value.info === "string";
}

/**
 * Validate markdown-it's host token stream while retaining the original token
 * instances. Unknown token properties and attrs are intentionally accepted:
 * markdown-it and plugins attach extra metadata that the renderer ignores.
 */
export function validateMarkdownTokenStream(value: unknown): MarkdownToken[] {
  if (!isUnknownArray(value) || !value.every(isMarkdownToken)) {
    throw new ValueError("markdown-it returned an invalid token stream");
  }
  return value;
}

export function parseMarkdownTokenStream(markdown: string): MarkdownToken[] {
  const parser = new MarkdownIt("commonmark").enable(["table", "strikethrough"]);
  const parsed: unknown = parser.parse(markdown, {});
  return validateMarkdownTokenStream(parsed);
}

function tokenAttr(token: MarkdownToken, name: string): string | undefined {
  const viaMethod = token.attrGet?.(name);
  if (typeof viaMethod === "string") return viaMethod;
  if (Array.isArray(token.attrs)) {
    for (const entry of token.attrs) {
      if (Array.isArray(entry) && entry.length >= 2 && entry[0] === name) {
        return typeof entry[1] === "string" ? entry[1] : String(entry[1]);
      }
    }
  }
  if (isUnknownRecord(token.attrs)) {
    const value = token.attrs[name];
    if (value !== undefined && value !== null) return String(value);
  }
  return undefined;
}

function pointsToTwips(points: number): number {
  return Math.round(points * 20);
}

function halfPoints(points: number): number {
  return Math.round(points * 2);
}

function lineSpacingTwips(multiplier: number): number {
  return Math.round(240 * multiplier);
}

function hexTuple(hex_color: string): [number, number, number] {
  return [
    Number.parseInt(hex_color.slice(0, 2), 16),
    Number.parseInt(hex_color.slice(2, 4), 16),
    Number.parseInt(hex_color.slice(4, 6), 16),
  ];
}

function tupleHex(rgb: [number, number, number]): string {
  return rgb
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, "0")
    )
    .join("")
    .toUpperCase();
}

export function mixColors(first: string, second: string, second_amount: number): string {
  const first_rgb = hexTuple(first);
  const second_rgb = hexTuple(second);
  return tupleHex([
    first_rgb[0] * (1.0 - second_amount) + second_rgb[0] * second_amount,
    first_rgb[1] * (1.0 - second_amount) + second_rgb[1] * second_amount,
    first_rgb[2] * (1.0 - second_amount) + second_rgb[2] * second_amount,
  ]);
}

function relativeLuminance(hex_color: string): number {
  const channels = hexTuple(hex_color).map((value) => {
    const normalized = value / 255.0;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrast_ratio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function ensureContrast(color: string, background: string, minimum = 4.5): string {
  if (contrast_ratio(color, background) >= minimum) return color;
  const target =
    contrast_ratio(BLACK, background) >= contrast_ratio(WHITE, background) ? BLACK : WHITE;
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mixColors(color, target, step / 20.0);
    if (contrast_ratio(candidate, background) >= minimum) return candidate;
  }
  return target;
}

export function derive_palette(theme: Theme, accent_override: string | null = null): ColorTokens {
  const accent = (accent_override || theme.accent).toUpperCase();
  const on_accent = contrast_ratio(WHITE, accent) >= contrast_ratio(BLACK, accent) ? WHITE : BLACK;
  const text = ensureContrast(theme.text_dark, WHITE);
  const text_muted = ensureContrast(theme.text_muted, WHITE);
  const link = ensureContrast(accent, WHITE);
  return {
    text,
    text_muted,
    heading: link,
    accent,
    accent_soft: mixColors(accent, WHITE, 0.86),
    on_accent,
    link,
    link_on_accent: on_accent,
    background: WHITE,
    surface: WHITE,
    surface_alt: mixColors(accent, WHITE, 0.95),
    border: mixColors(text, WHITE, 0.8),
    code_background: mixColors(text, WHITE, 0.95),
  };
}

export function type_scale(body_pt: number): TypeScale {
  return {
    title: Math.max(24.0, body_pt * 2.2),
    cover_title: Math.max(30.0, body_pt * 2.8),
    subtitle: Math.max(12.0, body_pt * 1.18),
    h1: Math.max(body_pt + 5.0, body_pt * 1.55),
    h2: Math.max(body_pt + 3.0, body_pt * 1.3),
    h3: Math.max(body_pt + 1.5, body_pt * 1.15),
    h4: body_pt,
    h5: Math.max(body_pt - 0.5, 8.0),
    h6: Math.max(body_pt - 1.0, 8.0),
    body: body_pt,
    table: Math.max(body_pt - 0.5, 8.0),
    caption: Math.max(body_pt - 1.0, 8.0),
    code: Math.max(body_pt - 1.5, 8.0),
    header_footer: Math.max(body_pt - 2.0, 8.0),
  };
}

export function content_width_in(options: Options): number {
  const page = PAGE_SIZES[options.page_size];
  const page_width = options.orientation === "landscape" ? page.height : page.width;
  return page_width - 2 * options.margin_inches;
}

export function content_height_in(options: Options): number {
  const page = PAGE_SIZES[options.page_size];
  const page_height = options.orientation === "landscape" ? page.width : page.height;
  return page_height - 2 * options.margin_inches;
}

function optString(spec: Record<string, unknown>, key: string): string | null {
  const value = spec[key];
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function enumValue<T extends readonly string[]>(
  spec: Record<string, unknown>,
  key: string,
  allowed: T,
  default_value: T[number]
): T[number] {
  const value = String(spec[key] ?? default_value).toLowerCase();
  if (!allowed.includes(value)) {
    throw new ValueError(
      `${key} must be one of ${JSON.stringify([...allowed])}, got ${JSON.stringify(value)}`
    );
  }
  return value as T[number];
}

function numberValue(
  spec: Record<string, unknown>,
  key: string,
  default_value: number,
  low: number,
  high: number
): number {
  const raw = spec[key];
  const value = Number(raw ?? default_value);
  if (!Number.isFinite(value) || value < low || value > high) {
    throw new ValueError(`${key} must be between ${low} and ${high}, got ${String(value)}`);
  }
  return value;
}

export function parse_options(spec: Record<string, unknown>, now = new Date()): Options {
  const theme_name = enumValue(
    spec,
    "theme",
    ["executive", "modern", "minimal", "editorial", "tech"] as const,
    "executive"
  );
  const theme = THEMES[theme_name];
  let accent = optString(spec, "accent_color");
  if (accent) {
    accent = accent.replace(/^#/, "").toUpperCase();
    if (!HEX_RE.test(accent)) {
      throw new ValueError(
        `accent_color must be a 6-digit hex color, got ${JSON.stringify(accent)}`
      );
    }
  }

  const author = optString(spec, "author");
  const legacy_cover = Boolean(spec.cover_page ?? false);
  let title_mode = enumValue(
    spec,
    "title_mode",
    ["auto", "none", "inline", "cover"] as const,
    "auto"
  );
  if (title_mode === "auto") {
    title_mode = legacy_cover ? "cover" : "inline";
  }

  let date = optString(spec, "date");
  if (date === null && (author || title_mode === "cover")) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    date = `${year}-${month}-${day}`;
  }

  const output_path = optString(spec, "output_path");
  if (!output_path) {
    throw new ValueError("output_path is required in the generator spec");
  }

  const body_size = numberValue(spec, "font_size_pt", 11.0, 8.0, 14.0);
  return {
    title: optString(spec, "title"),
    subtitle: optString(spec, "subtitle"),
    author,
    date,
    theme_name,
    theme,
    colors: derive_palette(theme, accent),
    scale: type_scale(body_size),
    font_size_pt: body_size,
    line_spacing: numberValue(spec, "line_spacing", 1.15, 1.0, 2.0),
    line_break_mode: enumValue(
      spec,
      "line_break_mode",
      ["preserve", "commonmark"] as const,
      "preserve"
    ),
    margin_inches: numberValue(spec, "margin_inches", 1.0, 0.4, 2.0),
    orientation: enumValue(spec, "orientation", ["portrait", "landscape"] as const, "portrait"),
    page_size: enumValue(spec, "page_size", ["letter", "a4"] as const, "letter"),
    title_mode: title_mode as Options["title_mode"],
    include_toc: Boolean(spec.include_toc ?? false),
    include_page_numbers: Boolean(spec.include_page_numbers ?? true),
    header_text: optString(spec, "header_text"),
    footer_text: optString(spec, "footer_text"),
    table_style: enumValue(
      spec,
      "table_style",
      ["banded", "minimal", "grid", "none"] as const,
      "banded"
    ),
    table_layout: enumValue(spec, "table_layout", ["content", "equal"] as const, "content"),
    output_path: path.resolve(output_path),
    staging_path: optString(spec, "staging_path") ? path.resolve(String(spec.staging_path)) : null,
    project_root: path.resolve(optString(spec, "project_root") ?? process.cwd()),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CancellationError();
  }
}

async function withGenerationStage<T>(name: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CancellationError || error instanceof DocumentGenerationError) {
      throw error;
    }
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new DocumentGenerationError(`${name}: ${reason}`);
  }
}

function load_markdown(spec: Record<string, unknown>): string {
  const markdown = spec.markdown;
  const markdown_path = spec.markdown_path;
  if (typeof markdown === "string" && markdown.trim()) return markdown;
  if (markdown_path) return fs.readFileSync(path.resolve(String(markdown_path)), "utf-8");
  throw new ValueError("spec requires non-empty 'markdown' or 'markdown_path'");
}

function plain_text(inline: MarkdownToken): string {
  return (inline.children ?? [])
    .filter((child) => child.type === "text" || child.type === "code_inline")
    .map((child) => child.content)
    .join("");
}

function derive_title(
  tokens: MarkdownToken[],
  options: Options
): { title: string; bodyNodes: MarkdownToken[] } {
  if (tokens[0]?.type === "heading_open" && tokens[0]?.tag === "h1") {
    const heading_text = plain_text(tokens[1] as MarkdownToken);
    const title = (options.title ?? heading_text) || "Document";
    if (
      options.title_mode !== "none" &&
      (options.title === null || options.title === heading_text)
    ) {
      return { title, bodyNodes: tokens.slice(3) };
    }
    return { title, bodyNodes: tokens };
  }
  return { title: options.title ?? "Document", bodyNodes: tokens };
}

function meta_line(options: Options): string | null {
  const parts = [options.author, options.date].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("  ·  ") : null;
}

function pageSectionProperties(
  options: Options
): NonNullable<ConstructorParameters<typeof Document>[0]>["sections"][number]["properties"] {
  const size = PAGE_SIZES[options.page_size];
  const width = options.orientation === "landscape" ? size.height : size.width;
  const height = options.orientation === "landscape" ? size.width : size.height;
  return {
    page: {
      size: {
        width: convertInchesToTwip(width),
        height: convertInchesToTwip(height),
        orientation:
          options.orientation === "landscape"
            ? PageOrientation.LANDSCAPE
            : PageOrientation.PORTRAIT,
      },
      margin: {
        top: convertInchesToTwip(options.margin_inches),
        right: convertInchesToTwip(options.margin_inches),
        bottom: convertInchesToTwip(options.margin_inches),
        left: convertInchesToTwip(options.margin_inches),
        header: 708,
        footer: 708,
        gutter: 0,
      },
    },
  };
}

function createHeader(options: Options): Header | undefined {
  if (!options.header_text) return undefined;
  return new Header({
    children: [
      new Paragraph({
        style: PENNY_HEADER_FOOTER,
        alignment: AlignmentType.RIGHT,
        children: [new TextRun(options.header_text)],
      }),
    ],
  });
}

function createFooter(options: Options): Footer | undefined {
  if (!options.footer_text && !options.include_page_numbers) return undefined;
  const children: TextRun[] = [];
  if (options.footer_text) {
    children.push(new TextRun(options.footer_text));
    if (options.include_page_numbers) children.push(new TextRun("\t"));
  }
  if (options.include_page_numbers) {
    children.push(new TextRun({ children: [PageNumber.CURRENT] }));
  }
  return new Footer({
    children: [
      new Paragraph({
        style: PENNY_HEADER_FOOTER,
        alignment:
          !options.footer_text && options.include_page_numbers ? AlignmentType.RIGHT : undefined,
        tabStops:
          options.footer_text && options.include_page_numbers
            ? [
                {
                  type: TabStopType.RIGHT,
                  position: convertInchesToTwip(content_width_in(options)),
                },
              ]
            : undefined,
        children,
      }),
    ],
  });
}

function customParagraphStyles(options: Options) {
  const { theme, colors, scale } = options;
  return [
    {
      id: PENNY_BODY,
      name: "Penny Body",
      basedOn: "Normal",
      run: { font: theme.body_font, size: halfPoints(scale.body), color: colors.text },
      paragraph: {
        spacing: {
          after: pointsToTwips(6),
          line: lineSpacingTwips(options.line_spacing),
          lineRule: LineRuleType.AUTO,
        },
      },
    },
    {
      id: PENNY_QUOTE,
      name: "Penny Quote",
      basedOn: PENNY_BODY,
      run: {
        font: theme.body_font,
        size: halfPoints(scale.body),
        color: colors.text_muted,
        italics: true,
      },
      paragraph: {
        indent: { left: convertInchesToTwip(0.25) },
        spacing: {
          after: pointsToTwips(2),
          line: lineSpacingTwips(options.line_spacing),
          lineRule: LineRuleType.AUTO,
        },
      },
    },
    {
      id: PENNY_TABLE_HEADER,
      name: "Penny Table Header",
      basedOn: PENNY_BODY,
      run: {
        font: theme.body_font,
        size: halfPoints(scale.table),
        color: colors.heading,
        bold: true,
      },
    },
    {
      id: PENNY_TABLE_HEADER_ACCENT,
      name: "Penny Table Header On Accent",
      basedOn: PENNY_BODY,
      run: {
        font: theme.body_font,
        size: halfPoints(scale.table),
        color: colors.on_accent,
        bold: true,
      },
    },
    {
      id: PENNY_TABLE_BODY,
      name: "Penny Table Body",
      basedOn: PENNY_BODY,
      run: { font: theme.body_font, size: halfPoints(scale.table), color: colors.text },
    },
    {
      id: PENNY_CAPTION,
      name: "Penny Caption",
      basedOn: PENNY_BODY,
      run: {
        font: theme.body_font,
        size: halfPoints(scale.caption),
        color: colors.text_muted,
        italics: true,
      },
      paragraph: {
        spacing: { after: pointsToTwips(8) },
      },
    },
    {
      id: PENNY_CODE_BLOCK,
      name: "Penny Code Block",
      basedOn: "Normal",
      run: { font: theme.mono_font, size: halfPoints(scale.code), color: colors.text },
      paragraph: {
        indent: {
          left: convertInchesToTwip(0.15),
          right: convertInchesToTwip(0.15),
        },
        spacing: {
          before: pointsToTwips(6),
          after: pointsToTwips(6),
          line: 240,
          lineRule: LineRuleType.AUTO,
        },
      },
    },
    {
      id: PENNY_LIST_CONTINUE,
      name: "Penny List Continue",
      basedOn: PENNY_BODY,
      run: { font: theme.body_font, size: halfPoints(scale.body), color: colors.text },
      paragraph: {
        spacing: {
          after: pointsToTwips(2),
          line: lineSpacingTwips(options.line_spacing),
          lineRule: LineRuleType.AUTO,
        },
      },
    },
    {
      id: PENNY_DOCUMENT_TITLE,
      name: "Penny Document Title",
      basedOn: "Normal",
      run: {
        font: theme.heading_font,
        size: halfPoints(scale.title),
        color: colors.heading,
        bold: true,
      },
      paragraph: { spacing: { after: pointsToTwips(2) }, keepNext: true },
    },
    {
      id: PENNY_COVER_TITLE,
      name: "Penny Cover Title",
      basedOn: "Normal",
      run: {
        font: theme.heading_font,
        size: halfPoints(scale.cover_title),
        color: colors.heading,
        bold: true,
      },
      paragraph: { spacing: { after: pointsToTwips(6) }, keepNext: true },
    },
    {
      id: PENNY_SUBTITLE,
      name: "Penny Subtitle",
      basedOn: "Normal",
      run: { font: theme.body_font, size: halfPoints(scale.subtitle), color: colors.text_muted },
      paragraph: { spacing: { after: pointsToTwips(2) }, keepNext: true },
    },
    {
      id: PENNY_METADATA,
      name: "Penny Metadata",
      basedOn: "Normal",
      run: { font: theme.body_font, size: halfPoints(scale.caption), color: colors.text_muted },
      paragraph: { spacing: { after: pointsToTwips(2) } },
    },
    {
      id: PENNY_HEADER_FOOTER,
      name: "Penny Header Footer",
      basedOn: "Normal",
      run: {
        font: theme.body_font,
        size: halfPoints(scale.header_footer),
        color: colors.text_muted,
      },
    },
  ] as const;
}

function customCharacterStyles(options: Options) {
  const { theme, colors } = options;
  return [
    {
      id: PENNY_HYPERLINK,
      name: "Penny Hyperlink",
      basedOn: "DefaultParagraphFont",
      run: { color: colors.link, underline: {} },
    },
    {
      id: PENNY_HYPERLINK_ACCENT,
      name: "Penny Hyperlink On Accent",
      basedOn: "DefaultParagraphFont",
      run: { color: colors.link_on_accent, underline: {} },
    },
    {
      id: PENNY_INLINE_CODE,
      name: "Penny Inline Code",
      basedOn: "DefaultParagraphFont",
      run: { font: theme.mono_font, color: colors.text, shading: { fill: colors.code_background } },
    },
    {
      id: PENNY_INLINE_CODE_ACCENT,
      name: "Penny Inline Code On Accent",
      basedOn: "DefaultParagraphFont",
      run: { font: theme.mono_font, color: colors.on_accent },
    },
  ] as const;
}

function createStyles(options: Options): ConstructorParameters<typeof Document>[0]["styles"] {
  const { theme, colors, scale } = options;
  return {
    default: {
      document: {
        run: { font: theme.body_font, size: halfPoints(scale.body), color: colors.text },
        paragraph: {
          spacing: {
            after: pointsToTwips(6),
            line: lineSpacingTwips(options.line_spacing),
            lineRule: LineRuleType.AUTO,
          },
        },
      },
      heading1: {
        run: {
          font: theme.heading_font,
          size: halfPoints(scale.h1),
          color: colors.heading,
          bold: true,
        },
        paragraph: {
          spacing: { before: pointsToTwips(16), after: pointsToTwips(6) },
          keepNext: true,
        },
      },
      heading2: {
        run: {
          font: theme.heading_font,
          size: halfPoints(scale.h2),
          color: colors.text,
          bold: true,
        },
        paragraph: {
          spacing: { before: pointsToTwips(12), after: pointsToTwips(4) },
          keepNext: true,
        },
      },
      heading3: {
        run: {
          font: theme.heading_font,
          size: halfPoints(scale.h3),
          color: colors.heading,
          bold: true,
        },
        paragraph: {
          spacing: { before: pointsToTwips(10), after: pointsToTwips(3) },
          keepNext: true,
        },
      },
      heading4: {
        run: {
          font: theme.heading_font,
          size: halfPoints(scale.h4),
          color: colors.text,
          bold: true,
        },
        paragraph: {
          spacing: { before: pointsToTwips(9), after: pointsToTwips(3) },
          keepNext: true,
        },
      },
      heading5: {
        run: {
          font: theme.heading_font,
          size: halfPoints(scale.h5),
          color: colors.text_muted,
          bold: true,
        },
        paragraph: {
          spacing: { before: pointsToTwips(8), after: pointsToTwips(2) },
          keepNext: true,
        },
      },
      heading6: {
        run: {
          font: theme.heading_font,
          size: halfPoints(scale.h6),
          color: colors.text_muted,
          italics: true,
        },
        paragraph: {
          spacing: { before: pointsToTwips(7), after: pointsToTwips(2) },
          keepNext: true,
        },
      },
      listParagraph: {
        run: { font: theme.body_font, size: halfPoints(scale.body), color: colors.text },
        paragraph: {
          spacing: {
            after: pointsToTwips(2),
            line: lineSpacingTwips(options.line_spacing),
            lineRule: LineRuleType.AUTO,
          },
        },
      },
      hyperlink: {
        run: { color: colors.link, underline: {} },
      },
    },
    paragraphStyles: [...customParagraphStyles(options)],
    characterStyles: [...customCharacterStyles(options)],
  };
}

type WordImageType = "jpg" | "png" | "gif" | "bmp";

function imageTypeForPath(filePath: string): WordImageType | undefined {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "jpg";
    case ".png":
      return "png";
    case ".gif":
      return "gif";
    case ".bmp":
      return "bmp";
    default:
      return undefined;
  }
}

class InlineRenderer {
  constructor(
    private readonly options: Options,
    private readonly warnings: string[],
    private readonly stats: Stats
  ) {}

  async render(
    tokens: MarkdownToken[],
    profile: RunProfile = DEFAULT_RUN_PROFILE,
    state: InlineState = { bold: false, italic: false, strike: false, in_link: false }
  ): Promise<Array<TextRun | ExternalHyperlink | ImageRun>> {
    const children: Array<TextRun | ExternalHyperlink | ImageRun> = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      switch (token.type) {
        case "strong_open":
          state = { ...state, bold: true };
          break;
        case "strong_close":
          state = { ...state, bold: false };
          break;
        case "em_open":
          state = { ...state, italic: true };
          break;
        case "em_close":
          state = { ...state, italic: false };
          break;
        case "s_open":
          state = { ...state, strike: true };
          break;
        case "s_close":
          state = { ...state, strike: false };
          break;
        case "text":
          children.push(this.textRun(token.content, state, profile));
          break;
        case "code_inline":
          children.push(
            this.textRun(
              token.content,
              state,
              profile,
              state.in_link ? profile.link_style : profile.code_style
            )
          );
          break;
        case "softbreak":
          if (this.options.line_break_mode === "preserve")
            children.push(this.breakRun(state, profile));
          else children.push(this.textRun(" ", state, profile));
          break;
        case "hardbreak":
          children.push(this.breakRun(state, profile));
          break;
        case "html_inline":
          if (BR_TAG_RE.test(token.content.trim())) children.push(this.breakRun(state, profile));
          break;
        case "image": {
          const image = await this.inlineImage(
            tokenAttr(token, "src") ?? "",
            token.content || tokenAttr(token, "alt") || ""
          );
          children.push(image);
          break;
        }
        case "link_open": {
          const closeIndex = this.findClose(tokens, index, "link_open", "link_close");
          const inner = await this.render(tokens.slice(index + 1, closeIndex), profile, {
            ...state,
            in_link: true,
          });
          children.push(
            new ExternalHyperlink({ link: tokenAttr(token, "href") ?? "", children: inner })
          );
          index = closeIndex;
          break;
        }
        case "link_close":
          break;
        default:
          break;
      }
    }
    return children;
  }

  private textRun(text: string, state: InlineState, profile: RunProfile, style?: string): TextRun {
    return new TextRun({
      text,
      bold: state.bold || undefined,
      italics: state.italic || profile.italic || undefined,
      strike: state.strike || undefined,
      style: style ?? (state.in_link ? profile.link_style : undefined),
    });
  }

  private breakRun(state: InlineState, profile: RunProfile): TextRun {
    return new TextRun({
      break: 1,
      bold: state.bold || undefined,
      italics: state.italic || profile.italic || undefined,
      strike: state.strike || undefined,
      style: state.in_link ? profile.link_style : undefined,
    });
  }

  private findClose(
    tokens: MarkdownToken[],
    start: number,
    openType: string,
    closeType: string
  ): number {
    let depth = 0;
    for (let index = start; index < tokens.length; index += 1) {
      if (tokens[index].type === openType) depth += 1;
      if (tokens[index].type === closeType) {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return tokens.length - 1;
  }

  private resolveImagePath(source: string): string {
    const expanded = source.startsWith("~")
      ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", source.slice(1))
      : source;
    return path.isAbsolute(expanded) ? expanded : path.join(this.options.project_root, expanded);
  }

  private imageDimensions(buffer: Buffer): { width: number; height: number } {
    const max_width = content_width_in(this.options);
    const max_height = Math.max(1.0, content_height_in(this.options) - 0.75);
    try {
      const size = imageSize(buffer);
      const natural_width = (size.width ?? Math.round(max_width * 96)) / 96;
      const natural_height =
        (size.height ?? Math.round(Math.min(max_height, max_width * 0.65) * 96)) / 96;
      const scale = Math.min(1.0, max_width / natural_width, max_height / natural_height);
      return {
        width: Math.max(1, Math.round(natural_width * scale * 96)),
        height: Math.max(1, Math.round(natural_height * scale * 96)),
      };
    } catch {
      return {
        width: Math.round(max_width * 96),
        height: Math.round(Math.min(max_height, max_width * 0.65) * 96),
      };
    }
  }

  private async inlineImage(source: string, alt: string): Promise<ImageRun | TextRun> {
    const resolved = this.resolveImagePath(source);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      this.warnings.push(`image not found: ${source}`);
      return new TextRun({
        text: `[image unavailable: ${alt || source}]`,
        font: this.options.theme.body_font,
        size: halfPoints(this.options.scale.caption),
        color: this.options.colors.text_muted,
      });
    }
    const imageType = imageTypeForPath(resolved);
    if (!imageType) {
      this.warnings.push(`unsupported image type: ${source}`);
      return new TextRun({
        text: `[image unavailable: ${alt || source}]`,
        font: this.options.theme.body_font,
        size: halfPoints(this.options.scale.caption),
        color: this.options.colors.text_muted,
      });
    }
    const data = fs.readFileSync(resolved);
    const { width, height } = this.imageDimensions(data);
    this.stats.images += 1;
    const description = alt || path.basename(resolved);
    return new ImageRun({
      type: imageType,
      data,
      transformation: { width, height },
      altText: { name: description, description, title: description },
    });
  }
}

class DocxRenderer {
  public readonly warnings: string[] = [];
  public readonly stats: Stats = { headings: 0, tables: 0, code_blocks: 0, images: 0 };
  private readonly inline_renderer: InlineRenderer;

  constructor(private readonly options: Options) {
    this.inline_renderer = new InlineRenderer(options, this.warnings, this.stats);
  }

  async render(tokens: MarkdownToken[]): Promise<Array<Paragraph | Table>> {
    const children: Array<Paragraph | Table> = [];
    for (let index = 0; index < tokens.length; ) {
      const rendered = await this.renderBlock(tokens, index);
      children.push(...rendered.children);
      index = rendered.next;
    }
    return children;
  }

  private async renderBlock(
    tokens: MarkdownToken[],
    index: number
  ): Promise<{ next: number; children: Array<Paragraph | Table> }> {
    const token = tokens[index];
    switch (token?.type) {
      case "heading_open":
        return this.renderHeading(tokens, index);
      case "paragraph_open":
        return this.renderParagraph(tokens, index);
      case "bullet_list_open":
      case "ordered_list_open":
        return this.renderList(tokens, index, 0);
      case "blockquote_open":
        return this.renderBlockquote(tokens, index);
      case "fence":
      case "code_block":
        return { next: index + 1, children: [this.renderCode(token)] };
      case "hr":
        return { next: index + 1, children: [this.renderRule()] };
      case "table_open":
        return this.renderTable(tokens, index);
      default:
        return { next: index + 1, children: [] };
    }
  }

  private async renderHeading(
    tokens: MarkdownToken[],
    index: number
  ): Promise<{ next: number; children: Paragraph[] }> {
    const level = Math.max(1, Math.min(6, Number.parseInt(tokens[index].tag.slice(1), 10) || 1));
    const inline = tokens[index + 1];
    const children = await this.inline_renderer.render(inline.children ?? []);
    this.stats.headings += 1;
    return {
      next: index + 3,
      children: [
        new Paragraph({
          heading: HEADING_LEVELS[level],
          border:
            level === 1
              ? {
                  bottom: {
                    style: BorderStyle.SINGLE,
                    color: this.options.colors.accent_soft,
                    size: 6,
                    space: 4,
                  },
                }
              : undefined,
          children,
        }),
      ],
    };
  }

  private async renderParagraph(
    tokens: MarkdownToken[],
    index: number
  ): Promise<{ next: number; children: Paragraph[] }> {
    const inline = tokens[index + 1];
    const children = inline.children ?? [];
    const only_image = children.length === 1 && children[0].type === "image";
    if (only_image) {
      return {
        next: index + 3,
        children: await this.renderBlockImage(
          tokenAttr(children[0], "src") ?? "",
          children[0].content || tokenAttr(children[0], "alt") || ""
        ),
      };
    }
    return {
      next: index + 3,
      children: [
        new Paragraph({
          style: PENNY_BODY,
          children: await this.inline_renderer.render(children),
        }),
      ],
    };
  }

  private async renderList(
    tokens: MarkdownToken[],
    index: number,
    depth: number
  ): Promise<{ next: number; children: Paragraph[] }> {
    const ordered = tokens[index].type === "ordered_list_open";
    const close_type = ordered ? "ordered_list_close" : "bullet_list_close";
    let number = Number.parseInt(tokenAttr(tokens[index], "start") ?? "1", 10) || 1;
    index += 1;
    const children: Paragraph[] = [];
    while (tokens[index]?.type !== close_type) {
      if (tokens[index]?.type === "list_item_open") {
        const item = await this.renderListItem(tokens, index, depth, ordered, number);
        children.push(...item.children);
        index = item.next;
        number += 1;
      } else {
        index += 1;
      }
    }
    return { next: index + 1, children };
  }

  private async renderListItem(
    tokens: MarkdownToken[],
    index: number,
    depth: number,
    ordered: boolean,
    number: number
  ): Promise<{ next: number; children: Paragraph[] }> {
    index += 1;
    let first_paragraph = true;
    const children: Paragraph[] = [];
    while (tokens[index]?.type !== "list_item_close") {
      if (tokens[index]?.type === "paragraph_open") {
        const rendered = await this.renderListParagraph(
          tokens,
          index,
          depth,
          ordered,
          ordered && first_paragraph ? number : null,
          !first_paragraph
        );
        children.push(rendered.paragraph);
        index = rendered.next;
        first_paragraph = false;
      } else if (
        tokens[index]?.type === "bullet_list_open" ||
        tokens[index]?.type === "ordered_list_open"
      ) {
        const nested = await this.renderList(tokens, index, depth + 1);
        children.push(...nested.children);
        index = nested.next;
      } else {
        const rendered = await this.renderBlock(tokens, index);
        children.push(
          ...rendered.children.filter((child): child is Paragraph => child instanceof Paragraph)
        );
        index = rendered.next;
      }
    }
    return { next: index + 1, children };
  }

  private async renderListParagraph(
    tokens: MarkdownToken[],
    index: number,
    depth: number,
    ordered: boolean,
    number: number | null,
    continuation: boolean
  ): Promise<{ next: number; paragraph: Paragraph }> {
    if (continuation) {
      return {
        next: index + 3,
        paragraph: new Paragraph({
          style: PENNY_LIST_CONTINUE,
          indent: { left: convertInchesToTwip(0.25 * Math.min(depth, 5) + 0.25) },
          spacing: {
            after: pointsToTwips(2),
            line: lineSpacingTwips(this.options.line_spacing),
            lineRule: LineRuleType.AUTO,
          },
          children: await this.inline_renderer.render(tokens[index + 1].children ?? []),
        }),
      };
    }

    if (ordered) {
      const left = 0.25 * Math.min(depth, 5) + 0.25;
      return {
        next: index + 3,
        paragraph: new Paragraph({
          style: PENNY_BODY,
          indent: {
            left: convertInchesToTwip(left),
            hanging: convertInchesToTwip(0.25),
          },
          tabStops: [{ type: TabStopType.LEFT, position: convertInchesToTwip(left) }],
          spacing: {
            after: pointsToTwips(2),
            line: lineSpacingTwips(this.options.line_spacing),
            lineRule: LineRuleType.AUTO,
          },
          children: [
            new TextRun(`${number}.	`),
            ...(await this.inline_renderer.render(tokens[index + 1].children ?? [])),
          ],
        }),
      };
    }

    return {
      next: index + 3,
      paragraph: new Paragraph({
        bullet: { level: Math.min(depth, 2) },
        children: await this.inline_renderer.render(tokens[index + 1].children ?? []),
      }),
    };
  }

  private async renderBlockquote(
    tokens: MarkdownToken[],
    index: number
  ): Promise<{ next: number; children: Paragraph[] }> {
    index += 1;
    let first = true;
    const children: Paragraph[] = [];
    while (tokens[index]?.type !== "blockquote_close") {
      if (tokens[index]?.type === "paragraph_open") {
        const nextTokenType = tokens[index + 3]?.type;
        children.push(
          new Paragraph({
            style: PENNY_QUOTE,
            border: {
              left: {
                style: BorderStyle.SINGLE,
                color: this.options.colors.accent,
                size: 18,
                space: 4,
              },
            },
            spacing: {
              before: pointsToTwips(first ? 6 : 2),
              after: pointsToTwips(nextTokenType === "blockquote_close" ? 6 : 2),
              line: lineSpacingTwips(this.options.line_spacing),
              lineRule: LineRuleType.AUTO,
            },
            children: await this.inline_renderer.render(tokens[index + 1].children ?? [], {
              ...DEFAULT_RUN_PROFILE,
              italic: true,
            }),
          })
        );
        first = false;
        index += 3;
      } else {
        const rendered = await this.renderBlock(tokens, index);
        children.push(
          ...rendered.children.filter((child): child is Paragraph => child instanceof Paragraph)
        );
        index = rendered.next;
      }
    }
    return { next: index + 1, children };
  }

  private renderCode(token: MarkdownToken): Paragraph {
    const lines = token.content.replace(/\n$/, "").split("\n");
    const children: TextRun[] = [];
    lines.forEach((line, line_index) => {
      children.push(new TextRun(line));
      if (line_index < lines.length - 1) children.push(new TextRun({ break: 1 }));
    });
    this.stats.code_blocks += 1;
    return new Paragraph({
      style: PENNY_CODE_BLOCK,
      shading: { fill: this.options.colors.code_background },
      border: {
        top: { style: BorderStyle.SINGLE, color: this.options.colors.border, size: 4 },
        bottom: { style: BorderStyle.SINGLE, color: this.options.colors.border, size: 4 },
        left: { style: BorderStyle.SINGLE, color: this.options.colors.border, size: 4 },
        right: { style: BorderStyle.SINGLE, color: this.options.colors.border, size: 4 },
      },
      children,
    });
  }

  private renderRule(): Paragraph {
    return new Paragraph({
      style: PENNY_BODY,
      spacing: { before: pointsToTwips(10), after: pointsToTwips(10) },
      border: {
        bottom: { style: BorderStyle.SINGLE, color: this.options.colors.border, size: 4, space: 4 },
      },
    });
  }

  private async renderBlockImage(source: string, alt: string): Promise<Paragraph[]> {
    const image = await this.inline_renderer.render([
      { type: "image", tag: "img", content: alt, attrs: { src: source } },
    ]);
    const is_placeholder = image[0] instanceof TextRun;
    if (is_placeholder) {
      return [
        new Paragraph({
          style: PENNY_BODY,
          alignment: AlignmentType.CENTER,
          children: image,
        }),
      ];
    }
    const imageParagraph = new Paragraph({
      style: PENNY_BODY,
      alignment: AlignmentType.CENTER,
      keepNext: Boolean(alt),
      children: image,
    });
    if (!alt) return [imageParagraph];
    return [
      imageParagraph,
      new Paragraph({
        style: PENNY_CAPTION,
        alignment: AlignmentType.CENTER,
        children: [new TextRun(alt)],
      }),
    ];
  }

  private async renderTable(
    tokens: MarkdownToken[],
    index: number
  ): Promise<{ next: number; children: Table[] }> {
    const rows: Array<{ cells: TableCellSpec[]; is_header: boolean }> = [];
    while (tokens[index]?.type !== "table_close") {
      if (tokens[index]?.type === "tr_open") {
        const row = this.collectRow(tokens, index);
        rows.push(row.row);
        index = row.next;
      } else {
        index += 1;
      }
    }
    this.stats.tables += 1;
    return { next: index + 1, children: rows.length > 0 ? [await this.emitTable(rows)] : [] };
  }

  private collectRow(
    tokens: MarkdownToken[],
    index: number
  ): { next: number; row: { cells: TableCellSpec[]; is_header: boolean } } {
    const cells: TableCellSpec[] = [];
    let is_header = false;
    index += 1;
    while (tokens[index]?.type !== "tr_close") {
      if (tokens[index]?.type === "th_open" || tokens[index]?.type === "td_open") {
        const cellToken = tokens[index];
        is_header = is_header || cellToken.type === "th_open";
        const style = tokenAttr(cellToken, "style") ?? "";
        const alignmentMatch = /text-align\s*:\s*(left|center|right)/.exec(style);
        const alignment = alignmentMatch?.[1];
        cells.push({
          children: tokens[index + 1].children ?? [],
          alignment:
            alignment === "left" || alignment === "center" || alignment === "right"
              ? alignment
              : null,
        });
        index += 3;
      } else {
        index += 1;
      }
    }
    return { next: index + 1, row: { cells, is_header } };
  }

  private visibleCellText(children: MarkdownToken[]): string {
    return children
      .map((token) => {
        if (token.type === "text" || token.type === "code_inline") return token.content;
        if (token.type === "image") return token.content || tokenAttr(token, "alt") || "";
        if (token.type === "softbreak" || token.type === "hardbreak") return " ";
        return "";
      })
      .join("")
      .trim();
  }

  private columnWidths(
    rows: Array<{ cells: TableCellSpec[]; is_header: boolean }>,
    columns: number
  ): number[] {
    if (this.options.table_layout === "equal") {
      return Array.from({ length: columns }, () => content_width_in(this.options) / columns);
    }

    const weights = Array.from({ length: columns }, (_, column_index) => {
      const lengths = rows
        .map((row) => row.cells[column_index])
        .filter((cell): cell is TableCellSpec => Boolean(cell))
        .map((cell) => this.visibleCellText(cell.children).length)
        .sort((left, right) => left - right);
      if (lengths.length === 0) return 6.0;
      const percentile_index = Math.round((lengths.length - 1) * 0.75);
      const weighted_length = 0.7 * lengths[percentile_index] + 0.3 * lengths[lengths.length - 1];
      return Math.max(6.0, Math.min(50.0, weighted_length));
    });

    const base_width = (content_width_in(this.options) * 0.35) / columns;
    const flexible_width = content_width_in(this.options) - base_width * columns;
    const total_weight = weights.reduce((sum, value) => sum + value, 0);
    return weights.map((weight) => base_width + (flexible_width * weight) / total_weight);
  }

  private async emitTable(
    rows: Array<{ cells: TableCellSpec[]; is_header: boolean }>
  ): Promise<Table> {
    const columns = Math.max(...rows.map((row) => row.cells.length));
    const widths = this.columnWidths(rows, columns).map(convertInchesToTwip);
    return new Table({
      width: { size: convertInchesToTwip(content_width_in(this.options)), type: WidthType.DXA },
      columnWidths: widths,
      layout: TableLayoutType.FIXED,
      borders: this.tableBorders(),
      rows: await Promise.all(
        rows.map(
          async (row, row_index) =>
            new TableRow({
              cantSplit: true,
              tableHeader: row.is_header,
              children: await Promise.all(
                Array.from({ length: columns }, async (_, column_index) => {
                  const cell = row.cells[column_index] ?? { children: [], alignment: null };
                  return this.buildCell(
                    cell,
                    row.is_header,
                    this.options.table_style === "banded" && !row.is_header && row_index % 2 === 0,
                    widths[column_index]
                  );
                })
              ),
            })
        )
      ),
    });
  }

  private tableBorders(): ConstructorParameters<typeof Table>[0]["borders"] | undefined {
    const hairline = { style: BorderStyle.SINGLE, color: this.options.colors.border, size: 4 };
    if (this.options.table_style === "banded") {
      return { top: hairline, bottom: hairline, insideHorizontal: hairline };
    }
    if (this.options.table_style === "grid") {
      return {
        top: hairline,
        bottom: hairline,
        left: hairline,
        right: hairline,
        insideHorizontal: hairline,
        insideVertical: hairline,
      };
    }
    return undefined;
  }

  private async buildCell(
    spec: TableCellSpec,
    is_header: boolean,
    band: boolean,
    width: number
  ): Promise<TableCell> {
    const filled_header =
      is_header && (this.options.table_style === "banded" || this.options.table_style === "grid");
    const paragraph_style = filled_header
      ? PENNY_TABLE_HEADER_ACCENT
      : is_header
        ? PENNY_TABLE_HEADER
        : PENNY_TABLE_BODY;
    const profile: RunProfile = filled_header
      ? { link_style: PENNY_HYPERLINK_ACCENT, code_style: PENNY_INLINE_CODE_ACCENT, italic: false }
      : DEFAULT_RUN_PROFILE;
    return new TableCell({
      width: { size: width, type: WidthType.DXA },
      verticalAlign: VerticalAlignTable.CENTER,
      margins: { top: 70, bottom: 70, left: 100, right: 100 },
      shading: filled_header
        ? { fill: this.options.colors.accent }
        : band
          ? { fill: this.options.colors.surface_alt }
          : undefined,
      borders:
        is_header && this.options.table_style === "minimal"
          ? {
              bottom: {
                style: BorderStyle.SINGLE,
                color: this.options.colors.accent,
                size: 12,
              },
            }
          : undefined,
      children: [
        new Paragraph({
          style: paragraph_style,
          alignment:
            spec.alignment === "left"
              ? AlignmentType.LEFT
              : spec.alignment === "center"
                ? AlignmentType.CENTER
                : spec.alignment === "right"
                  ? AlignmentType.RIGHT
                  : undefined,
          spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO },
          children: await this.inline_renderer.render(spec.children, profile),
        }),
      ],
    });
  }
}

function titleBlock(options: Options, title: string): Paragraph[] {
  const children: Paragraph[] = [
    new Paragraph({ style: PENNY_DOCUMENT_TITLE, children: [new TextRun(title)] }),
  ];
  if (options.subtitle) {
    children.push(
      new Paragraph({ style: PENNY_SUBTITLE, children: [new TextRun(options.subtitle)] })
    );
  }
  const metadata = meta_line(options);
  if (metadata) {
    children.push(new Paragraph({ style: PENNY_METADATA, children: [new TextRun(metadata)] }));
  }
  children.push(
    new Paragraph({
      style: PENNY_BODY,
      spacing: { after: pointsToTwips(12) },
      border: {
        bottom: { style: BorderStyle.SINGLE, color: options.colors.accent, size: 8, space: 4 },
      },
    })
  );
  return children;
}

function coverPage(options: Options, title: string): Paragraph[] {
  const available_points = content_height_in(options) * 72.0;
  const spacer_points = Math.max(72.0, Math.min(180.0, available_points * 0.28));
  const children: Paragraph[] = [
    new Paragraph({ style: PENNY_BODY, spacing: { before: pointsToTwips(spacer_points) } }),
    new Paragraph({
      style: PENNY_BODY,
      spacing: { after: pointsToTwips(18) },
      indent: { right: convertInchesToTwip(Math.max(content_width_in(options) - 1.6, 0)) },
      border: {
        top: { style: BorderStyle.SINGLE, color: options.colors.accent, size: 32, space: 4 },
      },
    }),
    new Paragraph({ style: PENNY_COVER_TITLE, children: [new TextRun(title)] }),
  ];
  if (options.subtitle) {
    children.push(
      new Paragraph({ style: PENNY_SUBTITLE, children: [new TextRun(options.subtitle)] })
    );
  }
  const metadata = meta_line(options);
  if (metadata) {
    children.push(
      new Paragraph({
        style: PENNY_METADATA,
        spacing: { before: pointsToTwips(30) },
        children: [new TextRun(metadata)],
      })
    );
  }
  return children;
}

function tocChildren(): Array<Paragraph | TableOfContents> {
  return [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Contents")] }),
    new TableOfContents("Contents", {
      headingStyleRange: "1-3",
      hyperlink: true,
      hideTabAndPageNumbersInWebView: true,
      useAppliedParagraphOutlineLevel: true,
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

type ParsedXmlNode = Record<string, unknown>;

const XML_ATTRIBUTE_PREFIX = "@_";
const INTERNAL_TARGET_MODE = "Internal";
const EXTERNAL_TARGET_MODE = "External";
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const HYPERLINK_RELATIONSHIP_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const SAFE_EXTERNAL_HYPERLINK_PROTOCOLS = new Set<string>(["http:", "https:", "mailto:"]);

function local_name(name: string): string {
  const parts = name.split(":");
  return parts[parts.length - 1] ?? name;
}

function as_xml_node(value: unknown, context: string): ParsedXmlNode {
  if (!isUnknownRecord(value)) {
    throw new ValueError(`invalid generated DOCX package: malformed XML structure in ${context}`);
  }
  return value;
}

function xml_attr(node: ParsedXmlNode, name: string): string | undefined {
  const value = node[`${XML_ATTRIBUTE_PREFIX}${name}`];
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function xml_child(node: ParsedXmlNode, wanted_local_name: string): unknown {
  for (const [name, value] of Object.entries(node)) {
    if (local_name(name) === wanted_local_name) return value;
  }
  return undefined;
}

function source_part_for_relationships_part(rels_part_name: string): string | null {
  if (rels_part_name === "_rels/.rels") return null;
  const marker = "/_rels/";
  const marker_index = rels_part_name.lastIndexOf(marker);
  if (marker_index < 0) {
    throw new ValueError(
      `invalid generated DOCX package: malformed relationships part path ${JSON.stringify(rels_part_name)}`
    );
  }
  const container = rels_part_name.slice(0, marker_index + 1);
  const rels_name = rels_part_name.slice(marker_index + marker.length);
  if (
    !rels_name.endsWith(".rels") ||
    rels_name.length <= ".rels".length ||
    rels_name.includes("/")
  ) {
    throw new ValueError(
      `invalid generated DOCX package: malformed relationships part path ${JSON.stringify(rels_part_name)}`
    );
  }
  return `${container}${rels_name.slice(0, -".rels".length)}`;
}

function relationships_in_part(parsed: unknown, rels_part_name: string): ParsedXmlNode[] {
  const document = as_xml_node(parsed, rels_part_name);
  const relationships_key = Object.keys(document).find(
    (name) => local_name(name) === "Relationships"
  );
  if (!relationships_key) {
    throw new ValueError(
      `invalid generated DOCX package: missing Relationships root in ${JSON.stringify(rels_part_name)}`
    );
  }
  const root_value = document[relationships_key];
  const relationships =
    root_value === "" || root_value === null ? {} : as_xml_node(root_value, rels_part_name);
  const raw_entries = xml_child(relationships, "Relationship");
  if (raw_entries === undefined) return [];
  const entries = Array.isArray(raw_entries) ? raw_entries : [raw_entries];
  return entries.map((entry, index) =>
    as_xml_node(entry, `${rels_part_name} relationship ${index + 1}`)
  );
}

function relationship_label(rels_part_name: string, rel_id: string | undefined): string {
  return rel_id ? `${rels_part_name} (${rel_id})` : rels_part_name;
}

function relationship_target_mode(
  relationship: ParsedXmlNode,
  rels_part_name: string,
  rel_id: string | undefined
): typeof INTERNAL_TARGET_MODE | typeof EXTERNAL_TARGET_MODE {
  const raw = xml_attr(relationship, "TargetMode");
  if (!raw || raw === INTERNAL_TARGET_MODE) return INTERNAL_TARGET_MODE;
  if (raw === EXTERNAL_TARGET_MODE) return EXTERNAL_TARGET_MODE;
  throw new ValueError(
    `invalid generated DOCX package: unsupported TargetMode ${JSON.stringify(raw)} in ${relationship_label(rels_part_name, rel_id)}`
  );
}

function validate_external_relationship_target(
  relationship: ParsedXmlNode,
  rels_part_name: string,
  rel_id: string | undefined,
  target: string
): void {
  const relationship_type = xml_attr(relationship, "Type");
  if (!relationship_type) {
    throw new ValueError(
      `invalid generated DOCX package: missing external relationship type in ${relationship_label(rels_part_name, rel_id)}`
    );
  }
  if (relationship_type !== HYPERLINK_RELATIONSHIP_TYPE) {
    throw new ValueError(
      `invalid generated DOCX package: unsupported external relationship type ${JSON.stringify(relationship_type)} in ${relationship_label(rels_part_name, rel_id)}`
    );
  }
  if (target.length === 0) {
    throw new ValueError(
      `invalid generated DOCX package: empty external relationship target in ${relationship_label(rels_part_name, rel_id)}`
    );
  }

  let parsed_target: URL;
  try {
    // Syntactic validation only. External targets are never fetched.
    parsed_target = new URL(target);
  } catch {
    throw new ValueError(
      `invalid generated DOCX package: invalid external relationship target ${JSON.stringify(target)} in ${relationship_label(rels_part_name, rel_id)}`
    );
  }

  const protocol = parsed_target.protocol.toLowerCase();
  if (!SAFE_EXTERNAL_HYPERLINK_PROTOCOLS.has(protocol)) {
    throw new ValueError(
      `invalid generated DOCX package: unsupported external hyperlink target scheme ${JSON.stringify(protocol)} in ${relationship_label(rels_part_name, rel_id)}`
    );
  }
}

function has_invalid_internal_target_character(target: string): boolean {
  if (target.includes("\\")) return true;
  return [...target].some((character) => {
    const code_point = character.codePointAt(0);
    return code_point !== undefined && (code_point <= 0x1f || code_point === 0x7f);
  });
}

function resolve_internal_relationship_target(
  rels_part_name: string,
  source_part_name: string | null,
  target: string,
  rel_id: string | undefined
): string {
  if (target.length === 0) {
    throw new ValueError(
      `invalid generated DOCX package: empty internal relationship target in ${relationship_label(rels_part_name, rel_id)}`
    );
  }
  if (
    has_invalid_internal_target_character(target) ||
    target.includes("?") ||
    target.includes("#")
  ) {
    throw new ValueError(
      `invalid generated DOCX package: invalid internal relationship target ${JSON.stringify(target)} in ${relationship_label(rels_part_name, rel_id)}`
    );
  }
  if (target.startsWith("//") || URI_SCHEME_RE.test(target)) {
    throw new ValueError(
      `invalid generated DOCX package: internal relationship target must stay inside the package in ${relationship_label(rels_part_name, rel_id)}`
    );
  }

  const resolved_segments = target.startsWith("/")
    ? []
    : (source_part_name?.split("/").slice(0, -1).filter(Boolean) ?? []);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (resolved_segments.length === 0) {
        throw new ValueError(
          `invalid generated DOCX package: relationship target traversal escapes the package in ${relationship_label(rels_part_name, rel_id)}`
        );
      }
      resolved_segments.pop();
      continue;
    }
    resolved_segments.push(segment);
  }

  if (target.endsWith("/") || resolved_segments.length === 0) {
    throw new ValueError(
      `invalid generated DOCX package: invalid internal relationship target ${JSON.stringify(target)} in ${relationship_label(rels_part_name, rel_id)}`
    );
  }
  return resolved_segments.join("/");
}

function validate_relationship_graph(
  part_names: ReadonlySet<string>,
  relationship_parts: ReadonlyMap<string, unknown>
): void {
  for (const [rels_part_name, parsed] of relationship_parts.entries()) {
    const source_part_name = source_part_for_relationships_part(rels_part_name);
    if (source_part_name && !part_names.has(source_part_name)) {
      throw new ValueError(
        `invalid generated DOCX package: relationships part ${JSON.stringify(rels_part_name)} refers to missing source part ${JSON.stringify(source_part_name)}`
      );
    }

    for (const relationship of relationships_in_part(parsed, rels_part_name)) {
      const rel_id = xml_attr(relationship, "Id");
      const target = xml_attr(relationship, "Target");
      if (!target) {
        throw new ValueError(
          `invalid generated DOCX package: missing relationship target in ${relationship_label(rels_part_name, rel_id)}`
        );
      }

      if (relationship_target_mode(relationship, rels_part_name, rel_id) === EXTERNAL_TARGET_MODE) {
        validate_external_relationship_target(relationship, rels_part_name, rel_id, target);
        continue;
      }

      const resolved_target = resolve_internal_relationship_target(
        rels_part_name,
        source_part_name,
        target,
        rel_id
      );
      if (!part_names.has(resolved_target)) {
        throw new ValueError(
          `invalid generated DOCX package: missing relationship target ${JSON.stringify(resolved_target)} referenced from ${relationship_label(rels_part_name, rel_id)}`
        );
      }
    }
  }
}

export async function validate_docx(path_to_docx: string): Promise<ValidationResult> {
  try {
    const buffer = fs.readFileSync(path_to_docx);
    const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
    const names = Object.keys(zip.files).filter((name) => !zip.files[name]?.dir);
    const missing = REQUIRED_DOCX_PARTS.filter((name) => !names.includes(name));
    if (missing.length > 0) {
      throw new ValueError(`DOCX package is missing required parts: ${JSON.stringify(missing)}`);
    }
    const part_names = new Set(names);
    const xml_parts = names.filter((name) => name.endsWith(".xml") || name.endsWith(".rels"));
    const relationship_parts = new Map<string, unknown>();
    for (const name of xml_parts) {
      const file = zip.file(name);
      if (!file) throw new ValueError(`DOCX package is missing XML part: ${name}`);
      const xml = await file.async("string");
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
        throw new ValueError(`invalid generated DOCX package: disallowed XML construct in ${name}`);
      }
      const validation = XMLValidator.validate(xml);
      if (validation !== true) {
        const detail =
          typeof validation === "object"
            ? (validation.err?.msg ?? JSON.stringify(validation))
            : String(validation);
        throw new ValueError(`invalid generated DOCX package: ${detail}`);
      }
      const parsed: unknown = XML_PARSER.parse(xml);
      if (name.endsWith(".rels")) relationship_parts.set(name, parsed);
    }
    validate_relationship_graph(part_names, relationship_parts);
    await patchDetector({ data: buffer });
    return {
      package_valid: true,
      reopen_valid: true,
      required_parts: [...REQUIRED_DOCX_PARTS].sort(),
      xml_parts_checked: xml_parts.length,
    };
  } catch (error) {
    if (error instanceof ValueError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ValueError(`invalid generated DOCX package: ${message}`);
  }
}

function reserveSiblingStagingPath(output_path: string): string {
  const target = path.resolve(output_path);
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

function ensureDistinctSiblingStaging(target: string, staging_path: string | null): string {
  if (!staging_path) return reserveSiblingStagingPath(target);
  const staging = path.resolve(staging_path);
  const resolved_target = path.resolve(target);
  if (path.dirname(staging) !== path.dirname(resolved_target) || staging === resolved_target) {
    throw new ValueError("staging_path must be a distinct file beside output_path");
  }
  if (!fs.existsSync(staging)) {
    const fd = fs.openSync(
      staging,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600
    );
    fs.closeSync(fd);
  }
  return staging;
}

export async function publish_docx_atomically(
  buffer: Buffer,
  output_path: string,
  staging_path: string | null = null
): Promise<{ path: string; validation: ValidationResult }> {
  const target = path.resolve(output_path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staging = ensureDistinctSiblingStaging(target, staging_path);
  try {
    const fd = fs.openSync(staging, "r+");
    try {
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, buffer, 0, buffer.length, 0);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const validation = await validate_docx(staging);
    fs.renameSync(staging, target);
    return { path: target, validation };
  } finally {
    fs.rmSync(staging, { force: true });
  }
}

function wordCount(markdown: string): number {
  const trimmed = markdown.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

export async function generate(
  spec: Record<string, unknown>,
  signal?: AbortSignal,
  hooks: GeneratorHooks = {}
): Promise<WordGenerationResult> {
  const options = await withGenerationStage("options", async () => parse_options(spec));
  throwIfAborted(signal);
  const markdown = await withGenerationStage("load_markdown", async () => load_markdown(spec));
  throwIfAborted(signal);
  const { title, bodyNodes, leading_h1_consumed } = await withGenerationStage(
    "parse_markdown",
    async () => {
      const tokens = parseMarkdownTokenStream(markdown);
      const derived = derive_title(tokens, options);
      return {
        ...derived,
        leading_h1_consumed:
          derived.bodyNodes !== tokens && derived.bodyNodes.length !== tokens.length,
      };
    }
  );
  throwIfAborted(signal);

  const { buffer, renderer } = await withGenerationStage("render", async () => {
    await hooks.before_render?.(signal);
    throwIfAborted(signal);
    const renderer = new DocxRenderer(options);
    const body_children = await renderer.render(bodyNodes);
    throwIfAborted(signal);

    const toc = options.include_toc ? tocChildren() : [];
    const header = createHeader(options);
    const footer = createFooter(options);
    const sections: Array<
      NonNullable<ConstructorParameters<typeof Document>[0]["sections"]>[number]
    > = [];

    if (options.title_mode === "cover") {
      sections.push({
        properties: pageSectionProperties(options),
        children: coverPage(options, title),
      });
      sections.push({
        properties: {
          ...pageSectionProperties(options),
          type: SectionType.NEXT_PAGE,
          page: {
            ...pageSectionProperties(options)?.page,
            pageNumbers: { start: 1 },
          },
        },
        headers: header ? { default: header } : undefined,
        footers: footer ? { default: footer } : undefined,
        children: [...toc, ...body_children],
      });
    } else {
      sections.push({
        properties: pageSectionProperties(options),
        headers: header ? { default: header } : undefined,
        footers: footer ? { default: footer } : undefined,
        children: [
          ...(options.title_mode === "inline" ? titleBlock(options, title) : []),
          ...toc,
          ...body_children,
        ],
      });
    }

    const doc = new Document({
      title,
      creator: options.author ?? undefined,
      styles: createStyles(options),
      features: { updateFields: options.include_toc },
      sections,
    });

    await hooks.before_pack?.(signal);
    throwIfAborted(signal);
    return { buffer: await Packer.toBuffer(doc), renderer };
  });

  throwIfAborted(signal);
  const published = await withGenerationStage("save_validate_publish", async () => {
    await hooks.before_publish?.(signal);
    throwIfAborted(signal);
    return publish_docx_atomically(buffer, options.output_path, options.staging_path);
  });

  const warnings = [...renderer.warnings];
  if (options.include_toc) {
    warnings.push(
      "The document contains a Word TOC field; viewers that do not refresh fields may require a manual update."
    );
  }

  return {
    path: published.path,
    title,
    theme: options.theme_name,
    words: wordCount(markdown),
    headings: renderer.stats.headings,
    tables: renderer.stats.tables,
    code_blocks: renderer.stats.code_blocks,
    images: renderer.stats.images,
    warnings,
    validation: published.validation,
    normalization: {
      line_break_mode: options.line_break_mode,
      title_mode: options.title_mode,
      table_layout: options.table_layout,
      leading_h1_consumed,
    },
    resolved_palette: options.colors,
    toc_field_update_requested: options.include_toc,
  };
}

export async function runInProcessGenerator(
  spec: Record<string, unknown>,
  signal?: AbortSignal,
  hooks: GeneratorHooks = {}
): Promise<WordGenerationResult> {
  return generate(spec, signal, hooks);
}
