import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as fontkit from "fontkit";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { imageSize } from "image-size";
import JSZip from "jszip";
import MarkdownIt from "markdown-it";
import pptxgen from "pptxgenjs";
import sharp from "sharp";

export interface Theme {
  accent: string;
  accent_light: string;
  text_dark: string;
  text_muted: string;
  heading_font: string;
  body_font: string;
  mono_font: string;
}

export interface Palette {
  text: string;
  text_muted: string;
  heading: string;
  accent: string;
  accent_text: string;
  accent_soft: string;
  on_accent: string;
  link: string;
  link_on_accent: string;
  background: string;
  surface: string;
  border: string;
  code_background: string;
  surface_alt: string;
  code_text: string;
  canvas_text: string;
  canvas_text_muted: string;
}

export interface PalettePatch {
  canvas?: string | null;
  surface?: string | null;
  accent?: string | null;
  text?: string | null;
  muted_text?: string | null;
}

export interface FocalPoint {
  x: number;
  y: number;
}

export interface Overlay {
  color: string;
  opacity: number;
}

export interface PreparedAsset {
  payload: Buffer;
  width_px: number;
  height_px: number;
  image_format: "PNG" | "JPEG";
}

export interface MediaSpec {
  path: string;
  fit: "crop" | "contain";
  focal_point: FocalPoint;
  overlay: Overlay | null;
  asset?: PreparedAsset | null;
}

export interface PlacedImage {
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fit: "crop" | "contain";
  focal_point: FocalPoint;
  asset?: PreparedAsset | null;
}

export interface DesignDefaults {
  palette: PalettePatch;
  background: MediaSpec | null;
  mark: PlacedImage | null;
  supplied: boolean;
}

export interface SlideDesignPatch {
  palette: PalettePatch;
  background_is_set: boolean;
  background: MediaSpec | null;
  mark_is_set: boolean;
  mark: PlacedImage | null;
  supplied: boolean;
}

export interface ResolvedDesign {
  palette: Palette;
  background: MediaSpec | null;
  mark: PlacedImage | null;
  active: boolean;
  requested_palette: PalettePatch;
  corrections: Array<Record<string, unknown>>;
  background_replaced_by_media: boolean;
}

export interface FontChoice {
  role: string;
  requested: string;
  resolved: string;
  substituted: boolean;
  verified: boolean;
  metrics_path: string | null;
  metrics_face_index: number;
  metrics_styles: Record<string, [string, number]> | null;
}

export interface FontMetricPlan {
  regular: string | FontMetricTuple | null;
  styles: Record<string, [string, number]>;
}

export type FontCatalogEntry = [string, string] | [string, string, number];
export type FontMetricTuple = [string, number];
export type FontMetricSource = string | FontMetricTuple | FontMetricPlan | null;

export interface Options {
  theme_name: keyof typeof THEMES;
  theme: Theme;
  palette: Palette;
  font_plan: FontChoice[];
  title: string | null;
  subtitle: string | null;
  author: string | null;
  date: string | null;
  footer_text: string | null;
  slide_numbers: boolean;
  line_break_mode: "preserve" | "commonmark";
  output_path: string;
  staging_path: string | null;
  project_root: string;
  design: DesignDefaults;
  allowed_image_roots: string[];
}

export interface ValidationResult {
  package_valid: true;
  reopen_valid: true;
  slide_count: number;
  required_parts: string[];
  xml_parts_checked: number;
  openxml_schema_validation: "not_performed";
}

export interface PowerpointGenerationResult {
  path: string;
  slide_count: number;
  layouts_used: Record<string, number>;
  theme: keyof typeof THEMES;
  warnings: string[];
  validation: ValidationResult;
  resolved_palette: Palette;
  resolved_design: {
    deck_default: Record<string, unknown>;
    slides: Array<Record<string, unknown>>;
  };
  fonts: FontChoice[];
  font_plan: FontChoice[];
  line_break_mode: Options["line_break_mode"];
  normalization: {
    line_break_mode: Options["line_break_mode"];
    split_slides: number;
    continued_tables: number;
    continued_content_slides: number;
  };
}

export interface GeneratorHooks {
  before_render?: (signal: AbortSignal | undefined) => Promise<void> | void;
  before_pack?: (signal: AbortSignal | undefined) => Promise<void> | void;
  before_publish?: (signal: AbortSignal | undefined) => Promise<void> | void;
}

const WHITE = "FFFFFF";
const BLACK = "000000";
const BAND_FILL = "F5F7FA";
const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: false,
  trimValues: false,
  attributeNamePrefix: "@_",
});
const _MD_INLINE = new MarkdownIt("commonmark").enable(["strikethrough"]);
const SAFE_EXTERNAL_HYPERLINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const HYPERLINK_RELATIONSHIP_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const INTERNAL_TARGET_MODE = "Internal";
const EXTERNAL_TARGET_MODE = "External";
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const BR_TAG_RE = /^<br\s*\/?>$/i;
const HTML_IMAGE_RE = /<\s*img\b/i;
const PARAGRAPH_SPLIT_RE = /\n[ \t]*\n+/u;
const REQUIRED_PPTX_PARTS = [
  "[Content_Types].xml",
  "_rels/.rels",
  "docProps/core.xml",
  "docProps/app.xml",
  "ppt/presentation.xml",
  "ppt/_rels/presentation.xml.rels",
] as const;
const MAX_STAGING_ATTEMPTS = 10;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_CENTRAL_DIRECTORY_FILE_HEADER_SIGNATURE = 0x02014b50;
const ZIP_CENTRAL_DIRECTORY_DIGITAL_SIGNATURE = 0x05054b50;
const ZIP_EOCD_FIXED_SIZE = 22;
const ZIP64_EOCD_MIN_SIZE = 56;
const ZIP64_EOCD_LOCATOR_SIZE = 20;
const ZIP_CENTRAL_DIRECTORY_FILE_HEADER_FIXED_SIZE = 46;
const ZIP_EOCD_MAX_COMMENT_SIZE = 0xffff;
const ZIP_EOCD_SEARCH_LIMIT =
  ZIP_EOCD_FIXED_SIZE + ZIP64_EOCD_LOCATOR_SIZE + ZIP_EOCD_MAX_COMMENT_SIZE;

export const THEMES = {
  executive: {
    accent: "1F3A5F",
    accent_light: "D9E2F3",
    text_dark: "1F2937",
    text_muted: "6B7280",
    heading_font: "Calibri Light",
    body_font: "Calibri",
    mono_font: "Consolas",
  },
  modern: {
    accent: "4F46E5",
    accent_light: "E0E7FF",
    text_dark: "111827",
    text_muted: "6B7280",
    heading_font: "Segoe UI",
    body_font: "Segoe UI",
    mono_font: "Consolas",
  },
  minimal: {
    accent: "111827",
    accent_light: "E5E7EB",
    text_dark: "111827",
    text_muted: "6B7280",
    heading_font: "Arial",
    body_font: "Arial",
    mono_font: "Consolas",
  },
  editorial: {
    accent: "7C2D12",
    accent_light: "EFDFD3",
    text_dark: "1F2937",
    text_muted: "6B7280",
    heading_font: "Georgia",
    body_font: "Georgia",
    mono_font: "Consolas",
  },
  tech: {
    accent: "0F766E",
    accent_light: "CCFBF1",
    text_dark: "111827",
    text_muted: "6B7280",
    heading_font: "Segoe UI",
    body_font: "Calibri",
    mono_font: "Consolas",
  },
} as const satisfies Record<string, Theme>;

export const LEGACY_LAYOUTS = [
  "title",
  "section",
  "content",
  "two_column",
  "table",
  "quote",
  "image",
  "closing",
] as const;
export const COMPOSED_LAYOUTS = ["image_left", "image_right", "full_bleed"] as const;
export const LAYOUTS = [...LEGACY_LAYOUTS, ...COMPOSED_LAYOUTS] as const;

type ThemeName = keyof typeof THEMES;
type LayoutName = (typeof LAYOUTS)[number];

export interface MarkdownTokenContract extends Record<string, unknown> {
  type: string;
  tag: string;
  content: string;
  attrs?: unknown;
  children?: unknown;
  attrGet?: (name: string) => unknown;
}

interface NormalizedBullet extends Record<string, unknown> {
  text: string;
  level: number;
  bold: boolean;
}

interface NormalizedColumn extends Record<string, unknown> {
  heading: unknown;
  body: unknown;
  body_parts: string[];
  bullets: NormalizedBullet[];
}

export interface NormalizedSlide extends Record<string, unknown> {
  layout: LayoutName;
  body: string | null;
  body_parts?: string[];
  bullets: NormalizedBullet[];
  left?: NormalizedColumn;
  right?: NormalizedColumn;
  _design_patch: SlideDesignPatch;
  _media?: MediaSpec;
}

interface MarkdownImage extends Record<string, unknown> {
  path: string;
  caption: string | null;
}

interface MarkdownTable extends Record<string, unknown> {
  headers: string[];
  rows: string[][];
}

interface MarkdownDraft extends Record<string, unknown> {
  title: string | null;
  bullets: NormalizedBullet[];
  body_parts: string[];
  images: MarkdownImage[];
  code_parts: string[];
  tables: MarkdownTable[];
  quote?: string;
  attribution?: string | null;
}

type PptxSlideBuilder = (spec: Record<string, unknown>) => Promise<PptxSlide>;
type OpenFont = fontkit.Font;

interface PptxHyperlink {
  slide?: number;
  tooltip?: string;
  url?: string;
}

interface PptxBorder {
  type?: "none" | "dash" | "solid";
  color?: string;
  pt?: number;
}

interface PptxFill {
  color?: string;
  transparency?: number;
}

interface PptxTextRunOptions {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  fit?: "none" | "shrink" | "resize";
  fill?: PptxFill;
  line?: PptxBorder;
  margin?: number | [number, number, number, number];
  objectName?: string;
  autoPage?: boolean;
  bold?: boolean;
  breakLine?: boolean;
  bullet?: { code?: string };
  color?: string;
  fontFace?: string;
  fontSize?: number;
  hyperlink?: PptxHyperlink;
  indentLevel?: number;
  isTextBox?: boolean;
  italic?: boolean;
  lineSpacing?: number;
  paraSpaceAfter?: number;
  paraSpaceBefore?: number;
  softBreakBefore?: boolean;
  strike?: boolean | "dblStrike" | "sngStrike";
}

interface PptxTextRun {
  text?: string;
  options?: PptxTextRunOptions;
}

type PptxRichText = PptxTextRun[];

interface PptxImageOptions {
  data?: string;
  objectName?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

interface PptxShapeOptions {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  fill?: PptxFill;
  line?: PptxBorder;
  objectName?: string;
}

interface PptxTableCellOptions extends PptxTextRunOptions {
  border?: PptxBorder | [PptxBorder, PptxBorder, PptxBorder, PptxBorder];
}

interface PptxTableCell {
  text?: string | PptxRichText;
  options?: PptxTableCellOptions;
}

type PptxTableRows = PptxTableCell[][];

interface PptxTableOptions extends PptxTextRunOptions {
  border?: PptxBorder | [PptxBorder, PptxBorder, PptxBorder, PptxBorder];
  colW?: number | number[];
  rowH?: number | number[];
}

interface PptxSlide {
  addImage(options: PptxImageOptions): PptxSlide;
  addNotes(notes: string): PptxSlide;
  addShape(shapeName: string, options?: PptxShapeOptions): PptxSlide;
  addTable(tableRows: PptxTableRows, options?: PptxTableOptions): PptxSlide;
  addText(text: string | PptxRichText, options?: PptxTextRunOptions): PptxSlide;
}

interface PptxTheme {
  bodyFontFace?: string;
  headFontFace?: string;
}

interface PptxWriteOptions {
  compression?: boolean;
  outputType?: "nodebuffer";
}

export interface PptxPresentation {
  layout: string;
  theme: PptxTheme;
  title: string;
  author: string;
  subject: string;
  addSlide(): unknown;
  defineLayout(layout: { name: string; width: number; height: number }): void;
  write(options?: PptxWriteOptions): Promise<unknown>;
}

type UnknownConstructor = new () => unknown;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isConstructable(value: unknown): value is UnknownConstructor {
  if (typeof value !== "function") return false;
  try {
    Reflect.construct(String, [], value);
    return true;
  } catch {
    return false;
  }
}

function isPptxPresentation(value: unknown): value is PptxPresentation {
  return (
    isUnknownRecord(value) &&
    typeof value.addSlide === "function" &&
    typeof value.defineLayout === "function" &&
    typeof value.write === "function"
  );
}

function isPptxSlide(value: unknown): value is PptxSlide {
  return (
    isUnknownRecord(value) &&
    typeof value.addImage === "function" &&
    typeof value.addNotes === "function" &&
    typeof value.addShape === "function" &&
    typeof value.addTable === "function" &&
    typeof value.addText === "function"
  );
}

/** Validate the open slide object returned by pptxgenjs without rejecting library extras. */
export function adaptPptxSlide(value: unknown): PptxSlide {
  if (!isPptxSlide(value)) {
    throw new TypeError("pptxgenjs addSlide returned an incompatible slide");
  }
  return value;
}

/**
 * Convert the result of a nodebuffer write without trusting pptxgenjs's broad
 * browser-and-Node return union. Buffer, Uint8Array, and ArrayBuffer are the
 * binary forms accepted by Buffer.from; strings, Blobs, and missing values are
 * rejected rather than converted into misleading PPTX bytes.
 */
export function pptxWriteOutputToBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new TypeError("pptxgenjs write returned incompatible nodebuffer output");
}

/**
 * Adapt pptxgenjs's runtime constructor to the renderer's narrow presentation
 * surface. The real constructor is invoked exactly once, constructor failures
 * propagate unchanged, required methods are validated, and extra members remain
 * accepted because pptxgenjs exposes a substantially larger public object.
 */
export function createPptxPresentation(constructorValue: unknown): PptxPresentation {
  if (!isConstructable(constructorValue)) {
    throw new TypeError("pptxgenjs default export is not constructable");
  }
  const presentation = new constructorValue();
  if (!isPptxPresentation(presentation)) {
    throw new TypeError("pptxgenjs constructor returned an incompatible presentation");
  }
  return presentation;
}

const FOOTER_LAYOUTS = new Set<LayoutName>([
  "content",
  "two_column",
  "table",
  "quote",
  "image",
  ...COMPOSED_LAYOUTS,
]);

function _is_string_member<T extends readonly string[]>(
  value: string,
  allowed: T
): value is T[number] {
  return allowed.some((candidate) => candidate === value);
}

function _is_theme_name(value: string): value is ThemeName {
  return _is_string_member(value, Object.keys(THEMES));
}

function _is_layout(value: string): value is LayoutName {
  return _is_string_member(value, LAYOUTS);
}

function _is_composed_layout(value: string): value is (typeof COMPOSED_LAYOUTS)[number] {
  return _is_string_member(value, COMPOSED_LAYOUTS);
}

function _is_font_collection(
  value: fontkit.Font | fontkit.FontCollection
): value is fontkit.FontCollection {
  return "fonts" in value;
}

function _is_font_metric_plan(source: FontMetricSource): source is FontMetricPlan {
  return (
    typeof source === "object" && source !== null && !Array.isArray(source) && "styles" in source
  );
}

function _defined_at<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new ValueError(`${label} is missing`);
  return value;
}

export const SLIDE_W = 13.333;
export const SLIDE_H = 7.5;
export const MARGIN = 0.7;
export const CONTENT_W = SLIDE_W - 2 * MARGIN;
export const CONTENT_TOP = 1.9;
export const CONTENT_BOTTOM = 6.85;
export const CONTENT_HEIGHT = CONTENT_BOTTOM - CONTENT_TOP;
export const BODY_FONT_PT = 14.0;
export const BODY_LINE_HEIGHT_IN = 0.25;
export const PARAGRAPH_GAP_IN = 0.11;
export const CODE_FONT_PT = 12.0;
export const CODE_LINE_HEIGHT_IN = 0.24;
export const CODE_PANEL_PADDING_IN = 0.25;
export const TABLE_HEADER_FONT_PT = 13.0;
export const TABLE_BODY_FONT_PT = 12.0;
export const TABLE_LINE_HEIGHT_IN = 0.23;
export const TABLE_CELL_VERTICAL_PADDING_IN = 0.12;
export const TABLE_MIN_ROW_HEIGHT_IN = 0.38;
export const TABLE_HEADER_MIN_HEIGHT_IN = 0.5;
export const BULLET_FONT_TIERS = [
  [16.0, 14.0, 12.5],
  [14.0, 13.0, 12.0],
  [13.0, 12.0, 11.0],
] as const;
export const BULLET_LINE_HEIGHT_FACTOR = 1.25;
export const BULLET_GAP_FACTOR = 0.45;
export const MIN_EFFECTIVE_PPI = 96.0;
export const POINTS_PER_INCH = 72.0;
export const PIXELS_PER_INCH = 96.0;
export const NEW_ASSET_MAX_BYTES = 25 * 1024 * 1024;
export const NEW_ASSET_MAX_PIXELS = 40_000_000;
export const COMPOSED_MEDIA_W = 5.05;
export const FULL_BLEED_PANEL: [number, number, number, number] = [0.7, 1.15, 6.15, 5.5];

const _SANS_FALLBACKS = ["Arial", "Liberation Sans", "Noto Sans", "DejaVu Sans"];
const _SERIF_FALLBACKS = ["Georgia", "Liberation Serif", "Noto Serif", "DejaVu Serif"];
const _MONO_FALLBACKS = ["Consolas", "Liberation Mono", "Noto Sans Mono", "DejaVu Sans Mono"];
const _SERIF_FAMILIES = new Set(["georgia", "times", "times new roman"]);
const _FONT_SUFFIXES = new Set([".ttf", ".otf", ".ttc"]);
const _HEX_RE = /^[0-9A-Fa-f]{6}$/;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ValueError(`${label} must be an object`);
  return value;
}

function nodeErrorCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.code === "string" ? value.code : undefined;
}

function _optional_array(
  value: unknown,
  label: string,
  options: { null_is_missing?: boolean } = {}
): unknown[] {
  if (value === undefined || (options.null_is_missing && value === null)) return [];
  if (!isUnknownArray(value)) throw new ValueError(`${label} must be an array`);
  return value;
}

function _string_array(
  value: unknown,
  label: string,
  options: { null_is_missing?: boolean } = {}
): string[] {
  return _optional_array(value, label, options).map(String);
}

function _number_array(value: unknown, label: string): number[] {
  return _optional_array(value, label).map((entry, index) => {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new ValueError(`${label}[${index}] must be a finite number`);
    }
    return entry;
  });
}

function _optional_record(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  return asRecord(value, label);
}

function _is_palette_patch(value: unknown): value is PalettePatch {
  if (!isRecord(value)) return false;
  for (const key of ["canvas", "surface", "accent", "text", "muted_text"]) {
    const entry = value[key];
    if (entry !== undefined && entry !== null && typeof entry !== "string") return false;
  }
  return true;
}

function _is_focal_point(value: unknown): value is FocalPoint {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y)
  );
}

function _is_overlay(value: unknown): value is Overlay {
  return (
    isRecord(value) &&
    typeof value.color === "string" &&
    typeof value.opacity === "number" &&
    Number.isFinite(value.opacity)
  );
}

function _is_prepared_asset(value: unknown): value is PreparedAsset {
  return (
    isRecord(value) &&
    Buffer.isBuffer(value.payload) &&
    typeof value.width_px === "number" &&
    Number.isFinite(value.width_px) &&
    typeof value.height_px === "number" &&
    Number.isFinite(value.height_px) &&
    (value.image_format === "PNG" || value.image_format === "JPEG")
  );
}

function _is_media_spec(value: unknown): value is MediaSpec {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    (value.fit === "crop" || value.fit === "contain") &&
    _is_focal_point(value.focal_point) &&
    (value.overlay === null || _is_overlay(value.overlay)) &&
    (value.asset === undefined || value.asset === null || _is_prepared_asset(value.asset))
  );
}

function _is_placed_image(value: unknown): value is PlacedImage {
  return (
    _is_media_spec({
      ...(isRecord(value) ? value : {}),
      overlay: null,
    }) &&
    isRecord(value) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    typeof value.height === "number" &&
    Number.isFinite(value.height)
  );
}

function _is_slide_design_patch(value: unknown): value is SlideDesignPatch {
  return (
    isRecord(value) &&
    _is_palette_patch(value.palette) &&
    typeof value.background_is_set === "boolean" &&
    (value.background === null || _is_media_spec(value.background)) &&
    typeof value.mark_is_set === "boolean" &&
    (value.mark === null || _is_placed_image(value.mark)) &&
    typeof value.supplied === "boolean"
  );
}

function _empty_slide_design_patch(): SlideDesignPatch {
  return {
    palette: {},
    background_is_set: false,
    background: null,
    mark_is_set: false,
    mark: null,
    supplied: false,
  };
}

/** Validate open internal design metadata while retaining additive renderer extras. */
export function adaptInternalSlideDesignPatch(value: unknown, label = "slide"): SlideDesignPatch {
  if (!_is_slide_design_patch(value)) {
    throw new ValueError(`${label} has invalid internal design metadata`);
  }
  return value;
}

function _slide_design_patch(container: Record<string, unknown>, label: string): SlideDesignPatch {
  const value = container._design_patch;
  return value === undefined
    ? _empty_slide_design_patch()
    : adaptInternalSlideDesignPatch(value, label);
}

/** Validate prepared/open internal media metadata without closing future extras. */
export function adaptInternalMediaSpec(value: unknown, label = "slide"): MediaSpec {
  if (!_is_media_spec(value)) {
    throw new ValueError(`${label} has invalid internal media metadata`);
  }
  return value;
}

function _media_spec_or_null(
  container: Record<string, unknown>,
  key: string,
  label: string
): MediaSpec | null {
  const value = container[key];
  if (value === undefined) return null;
  return adaptInternalMediaSpec(value, label);
}

function isMarkdownTokenContract(value: unknown): value is MarkdownTokenContract {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    typeof value.tag === "string" &&
    typeof value.content === "string" &&
    (value.attrGet === undefined || typeof value.attrGet === "function")
  );
}

/** Validate markdown-it's open token objects while retaining plugin/library extras. */
export function parseMarkdownTokenArray(
  value: unknown,
  label = "markdown parser output"
): MarkdownTokenContract[] {
  if (!isUnknownArray(value)) throw new ValueError(`${label} must be an array of tokens`);
  const tokens: MarkdownTokenContract[] = [];
  value.forEach((entry, index) => {
    if (!isMarkdownTokenContract(entry)) {
      throw new ValueError(`${label}[${index}] is not a compatible markdown token`);
    }
    tokens.push(entry);
  });
  return tokens;
}

function _markdown_tokens(
  parser: MarkdownIt,
  source: string,
  inline: boolean,
  label: string
): MarkdownTokenContract[] {
  const parsed: unknown = inline ? parser.parseInline(source, {}) : parser.parse(source, {});
  return parseMarkdownTokenArray(parsed, label);
}

function _token_at(
  tokens: readonly MarkdownTokenContract[],
  index: number,
  label: string
): MarkdownTokenContract {
  return _defined_at(tokens, index, label);
}

function _token_children(token: MarkdownTokenContract, label: string): MarkdownTokenContract[] {
  if (token.children === undefined || token.children === null) return [];
  return parseMarkdownTokenArray(token.children, `${label}.children`);
}

function tokenAttr(token: MarkdownTokenContract, name: string): string | undefined {
  if (typeof token.attrGet === "function") {
    const viaMethod = token.attrGet(name);
    if (typeof viaMethod === "string") return viaMethod;
    if (viaMethod !== null && viaMethod !== undefined) {
      throw new ValueError(`markdown token attribute ${JSON.stringify(name)} must be a string`);
    }
  }
  if (token.attrs === undefined || token.attrs === null) return undefined;
  const attrs = _optional_array(token.attrs, "markdown token attrs");
  for (const entry of attrs) {
    if (!isUnknownArray(entry) || entry.length < 2) {
      throw new ValueError("markdown token attrs must contain name/value pairs");
    }
    const [entry_name, entry_value] = entry;
    if (typeof entry_name !== "string" || typeof entry_value !== "string") {
      throw new ValueError("markdown token attrs must contain string name/value pairs");
    }
    if (entry_name === name) return entry_value;
  }
  return undefined;
}

export function _mix(hex_color: string, other: string, factor: number): string {
  const a = [0, 2, 4].map((index) => Number.parseInt(hex_color.slice(index, index + 2), 16));
  const b = [0, 2, 4].map((index) => Number.parseInt(other.slice(index, index + 2), 16));
  return a
    .map((value, index) =>
      Math.round(value + (b[index] - value) * factor)
        .toString(16)
        .padStart(2, "0")
    )
    .join("")
    .toUpperCase();
}

export function _hex_to_triplet(hex_color: string): [number, number, number] {
  return [
    Number.parseInt(hex_color.slice(0, 2), 16),
    Number.parseInt(hex_color.slice(2, 4), 16),
    Number.parseInt(hex_color.slice(4, 6), 16),
  ];
}

export function _relative_luminance(hex_color: string): number {
  const channels = _hex_to_triplet(hex_color).map((value) => {
    const normalized = value / 255.0;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function _contrast_ratio(foreground: string, background: string): number {
  const light = Math.max(_relative_luminance(foreground), _relative_luminance(background));
  const dark = Math.min(_relative_luminance(foreground), _relative_luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

function _ensure_contrast(foreground: string, background: string, minimum = 4.5): string {
  if (_contrast_ratio(foreground, background) >= minimum) return foreground;
  const direction =
    _contrast_ratio(BLACK, background) > _contrast_ratio(WHITE, background) ? BLACK : WHITE;
  for (let step = 1; step <= 18; step += 1) {
    const candidate = _mix(foreground, direction, step / 18.0);
    if (_contrast_ratio(candidate, background) >= minimum) return candidate;
  }
  return direction;
}

function _ensure_contrast_all(foreground: string, backgrounds: string[], minimum = 4.5): string {
  if (backgrounds.every((background) => _contrast_ratio(foreground, background) >= minimum)) {
    return foreground;
  }
  const directions = [BLACK, WHITE].sort((left, right) => {
    const leftScore = Math.min(
      ...backgrounds.map((background) => _contrast_ratio(left, background))
    );
    const rightScore = Math.min(
      ...backgrounds.map((background) => _contrast_ratio(right, background))
    );
    return rightScore - leftScore;
  });
  for (const direction of directions) {
    for (let step = 1; step <= 100; step += 1) {
      const candidate = _mix(foreground, direction, step / 100.0);
      if (backgrounds.every((background) => _contrast_ratio(candidate, background) >= minimum)) {
        return candidate;
      }
    }
  }
  throw new ValueError("no foreground color can satisfy the required contrast on every surface");
}

function _contrast_safe_surface_variant(
  surface: string,
  foregrounds: string[],
  factor: number,
  minimum = 4.5
): string {
  for (let step = Math.round(factor * 100); step >= 0; step -= 1) {
    const amount = step / 100.0;
    const candidates = [_mix(surface, BLACK, amount), _mix(surface, WHITE, amount)];
    const valid = candidates.filter((candidate) =>
      foregrounds.every((foreground) => _contrast_ratio(foreground, candidate) >= minimum)
    );
    if (valid.length > 0) {
      valid.sort((left, right) => {
        const leftScore = Math.min(
          ...foregrounds.map((foreground) => _contrast_ratio(foreground, left))
        );
        const rightScore = Math.min(
          ...foregrounds.map((foreground) => _contrast_ratio(foreground, right))
        );
        return rightScore - leftScore;
      });
      return valid[0];
    }
  }
  throw new ValueError("could not derive a contrast-safe semantic surface");
}

export function _derive_palette(theme: Theme): Palette {
  const accent = theme.accent;
  const on_accent =
    _contrast_ratio(BLACK, accent) >= _contrast_ratio(WHITE, accent) ? BLACK : WHITE;
  return {
    text: _ensure_contrast(theme.text_dark, WHITE),
    text_muted: _ensure_contrast(theme.text_muted, WHITE),
    heading: _ensure_contrast(theme.text_dark, WHITE),
    accent,
    accent_text: _ensure_contrast(accent, WHITE),
    accent_soft: _mix(accent, WHITE, 0.88),
    on_accent,
    link: _ensure_contrast(accent, WHITE),
    link_on_accent: on_accent,
    background: WHITE,
    surface: WHITE,
    border: _mix(theme.text_dark, WHITE, 0.85),
    code_background: _mix(theme.text_dark, WHITE, 0.95),
    surface_alt: BAND_FILL,
    code_text: _ensure_contrast(theme.text_dark, _mix(theme.text_dark, WHITE, 0.95)),
    canvas_text: _ensure_contrast(theme.text_dark, WHITE),
    canvas_text_muted: _ensure_contrast(theme.text_muted, WHITE),
  };
}

function _merge_palette_patch(base: PalettePatch, patch: PalettePatch): PalettePatch {
  return {
    canvas: patch.canvas ?? base.canvas ?? null,
    surface: patch.surface ?? base.surface ?? null,
    accent: patch.accent ?? base.accent ?? null,
    text: patch.text ?? base.text ?? null,
    muted_text: patch.muted_text ?? base.muted_text ?? null,
  };
}

export function _derive_design_palette(
  legacy: Palette,
  patch: PalettePatch
): [Palette, Array<Record<string, unknown>>] {
  const canvas = patch.canvas ?? legacy.background;
  const surface = patch.surface ?? legacy.surface;
  const accent = patch.accent ?? legacy.accent;
  const text_preference = patch.text ?? legacy.text;
  const muted_preference = patch.muted_text ?? legacy.text_muted;

  let text = _ensure_contrast(text_preference, surface);
  let muted_text = _ensure_contrast(muted_preference, surface);
  let accent_text = _ensure_contrast(accent, surface);
  const semantic_foregrounds = [text, muted_text, accent_text];
  const surface_alt = _contrast_safe_surface_variant(surface, semantic_foregrounds, 0.07);
  const code_background = _contrast_safe_surface_variant(surface, semantic_foregrounds, 0.11);
  const surface_backgrounds = [surface, surface_alt, code_background];
  text = _ensure_contrast_all(text, surface_backgrounds);
  muted_text = _ensure_contrast_all(muted_text, surface_backgrounds);
  accent_text = _ensure_contrast_all(accent_text, surface_backgrounds);
  const canvas_text = _ensure_contrast(text_preference, canvas);
  const canvas_text_muted = _ensure_contrast(muted_preference, canvas);
  const on_accent =
    _contrast_ratio(BLACK, accent) >= _contrast_ratio(WHITE, accent) ? BLACK : WHITE;
  const palette: Palette = {
    text,
    text_muted: muted_text,
    heading: text,
    accent,
    accent_text,
    accent_soft: _mix(accent, surface, 0.82),
    on_accent,
    link: accent_text,
    link_on_accent: on_accent,
    background: canvas,
    surface,
    border: _mix(surface, text, 0.2),
    code_background,
    surface_alt,
    code_text: text,
    canvas_text,
    canvas_text_muted,
  };

  const corrections: Array<Record<string, unknown>> = [];
  const cases: Array<
    ["text" | "muted_text" | "accent", string | null | undefined, Array<[string, string, string]>]
  > = [
    [
      "text",
      patch.text,
      [
        ["surface_text", text, surface],
        ["canvas_text", canvas_text, canvas],
      ],
    ],
    [
      "muted_text",
      patch.muted_text,
      [
        ["surface_muted_text", muted_text, surface],
        ["canvas_muted_text", canvas_text_muted, canvas],
      ],
    ],
    [
      "accent",
      patch.accent,
      [
        ["accent_text", accent_text, surface],
        ["link", accent_text, surface],
      ],
    ],
  ];
  for (const [requested_role, requested, actuals] of cases) {
    if (!requested) continue;
    for (const [actual_role, actual, background] of actuals) {
      if (actual !== requested) {
        corrections.push({
          requested_role,
          actual_role,
          requested,
          actual,
          background,
          decorative_value_preserved: requested_role === "accent",
        });
      }
    }
  }
  return [palette, corrections];
}

function _opt_str(spec: Record<string, unknown>, key: string): string | null {
  const value = spec[key];
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function _opt_enum<T extends readonly string[]>(
  spec: Record<string, unknown>,
  key: string,
  allowed: T,
  default_value: T[number]
): T[number] {
  const value = String(spec[key] ?? default_value).toLowerCase();
  if (!_is_string_member(value, allowed)) {
    throw new ValueError(
      `${key} must be one of ${JSON.stringify([...allowed])}, got ${JSON.stringify(value)}`
    );
  }
  return value;
}

function _strict_object(
  value: unknown,
  label: string,
  allowed: Set<string>
): Record<string, unknown> {
  const raw = asRecord(value, label);
  const unknown = Object.keys(raw)
    .filter((key) => !allowed.has(key))
    .sort();
  if (unknown.length > 0) {
    throw new ValueError(`${label} contains unknown keys: ${JSON.stringify(unknown)}`);
  }
  return raw;
}

function _strict_hex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^#?[0-9A-Fa-f]{6}$/.test(value)) {
    throw new ValueError(`${label} must be a strict 6-digit hex color`);
  }
  return value.replace(/^#/, "").toUpperCase();
}

function _strict_number(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ValueError(`${label} must be in [${minimum}, ${maximum}]`);
  }
  return value;
}

function _strict_path(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    throw new ValueError(`${label} must be a non-empty local path string`);
  }
  return value;
}

function _parse_focal_point(value: unknown, label: string): FocalPoint {
  const raw = _strict_object(value, label, new Set(["x", "y"]));
  if (!("x" in raw) || !("y" in raw)) throw new ValueError(`${label} requires x and y`);
  return {
    x: _strict_number(raw.x, `${label}.x`, 0.0, 1.0),
    y: _strict_number(raw.y, `${label}.y`, 0.0, 1.0),
  };
}

function _parse_overlay(value: unknown, label: string): Overlay {
  const raw = _strict_object(value, label, new Set(["color", "opacity"]));
  if (!("opacity" in raw)) throw new ValueError(`${label}.opacity is required`);
  return {
    color: _strict_hex(raw.color ?? "000000", `${label}.color`),
    opacity: _strict_number(raw.opacity, `${label}.opacity`, 0.0, 1.0),
  };
}

function _parse_fit(value: unknown, label: string): "crop" | "contain" {
  if (value !== "crop" && value !== "contain") {
    throw new ValueError(`${label} must be 'crop' or 'contain'`);
  }
  return value;
}

function _parse_media(value: unknown, label: string, default_fit: "crop" | "contain"): MediaSpec {
  const raw = _strict_object(value, label, new Set(["path", "fit", "focal_point", "overlay"]));
  if (!("path" in raw)) throw new ValueError(`${label}.path is required`);
  return {
    path: _strict_path(raw.path, `${label}.path`),
    fit: "fit" in raw ? _parse_fit(raw.fit, `${label}.fit`) : default_fit,
    focal_point:
      "focal_point" in raw
        ? _parse_focal_point(raw.focal_point, `${label}.focal_point`)
        : { x: 0.5, y: 0.5 },
    overlay: "overlay" in raw ? _parse_overlay(raw.overlay, `${label}.overlay`) : null,
    asset: null,
  };
}

function _parse_placed_image(value: unknown, label: string): PlacedImage {
  const raw = _strict_object(
    value,
    label,
    new Set(["path", "x", "y", "width", "height", "fit", "focal_point"])
  );
  const required = ["path", "x", "y", "width", "height"];
  const missing = required.filter((key) => !(key in raw));
  if (missing.length > 0)
    throw new ValueError(`${label} is missing required keys: ${JSON.stringify(missing)}`);
  const x = _strict_number(raw.x, `${label}.x`, 0.0, 1.0);
  const y = _strict_number(raw.y, `${label}.y`, 0.0, 1.0);
  const width = _strict_number(raw.width, `${label}.width`, 0.0, 1.0);
  const height = _strict_number(raw.height, `${label}.height`, 0.0, 1.0);
  if (width <= 0.0 || height <= 0.0)
    throw new ValueError(`${label}.width and height must be positive`);
  if (x + width > 1.0 || y + height > 1.0) {
    throw new ValueError(`${label} must remain inside normalized slide bounds`);
  }
  return {
    path: _strict_path(raw.path, `${label}.path`),
    x,
    y,
    width,
    height,
    fit: "fit" in raw ? _parse_fit(raw.fit, `${label}.fit`) : "contain",
    focal_point:
      "focal_point" in raw
        ? _parse_focal_point(raw.focal_point, `${label}.focal_point`)
        : { x: 0.5, y: 0.5 },
    asset: null,
  };
}

function _parse_palette_patch(value: unknown, label: string): PalettePatch {
  const raw = _strict_object(
    value,
    label,
    new Set(["canvas", "surface", "accent", "text", "muted_text"])
  );
  return {
    canvas: "canvas" in raw ? _strict_hex(raw.canvas, `${label}.canvas`) : null,
    surface: "surface" in raw ? _strict_hex(raw.surface, `${label}.surface`) : null,
    accent: "accent" in raw ? _strict_hex(raw.accent, `${label}.accent`) : null,
    text: "text" in raw ? _strict_hex(raw.text, `${label}.text`) : null,
    muted_text: "muted_text" in raw ? _strict_hex(raw.muted_text, `${label}.muted_text`) : null,
  };
}

function _parse_deck_design(spec: Record<string, unknown>): DesignDefaults {
  if (!("design" in spec)) {
    return { palette: {}, background: null, mark: null, supplied: false };
  }
  const raw = _strict_object(spec.design, "design", new Set(["palette", "background", "mark"]));
  return {
    palette: "palette" in raw ? _parse_palette_patch(raw.palette, "design.palette") : {},
    background:
      "background" in raw ? _parse_media(raw.background, "design.background", "crop") : null,
    mark: "mark" in raw ? _parse_placed_image(raw.mark, "design.mark") : null,
    supplied: true,
  };
}

function _parse_slide_design(raw_slide: Record<string, unknown>): SlideDesignPatch {
  if (!("design" in raw_slide)) {
    return {
      palette: {},
      background_is_set: false,
      background: null,
      mark_is_set: false,
      mark: null,
      supplied: false,
    };
  }
  const raw = _strict_object(
    raw_slide.design,
    "slide.design",
    new Set(["palette", "background", "mark"])
  );
  return {
    palette: "palette" in raw ? _parse_palette_patch(raw.palette, "slide.design.palette") : {},
    background_is_set: "background" in raw,
    background:
      raw.background === null || !("background" in raw)
        ? null
        : _parse_media(raw.background, "slide.design.background", "crop"),
    mark_is_set: "mark" in raw,
    mark:
      raw.mark === null || !("mark" in raw)
        ? null
        : _parse_placed_image(raw.mark, "slide.design.mark"),
    supplied: true,
  };
}

function _parse_allowed_image_roots(spec: Record<string, unknown>): string[] {
  if (!("allowed_image_roots" in spec)) return [];
  const roots = spec.allowed_image_roots;
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new ValueError("allowed_image_roots must be a non-empty array of local directory paths");
  }
  return roots.map((root, index) => _strict_path(root, `allowed_image_roots[${index}]`));
}

function _resolve_theme(spec: Record<string, unknown>): [ThemeName, Theme] {
  const name = String(spec.theme ?? "executive").toLowerCase();
  if (!_is_theme_name(name)) {
    throw new ValueError(
      `theme must be one of ${JSON.stringify(Object.keys(THEMES))}, got ${JSON.stringify(name)}`
    );
  }
  let theme: Theme = { ...THEMES[name] };
  const accent = _opt_str(spec, "accent_color");
  if (accent) {
    const normalized = accent.replace(/^#/, "").toUpperCase();
    if (!_HEX_RE.test(normalized)) {
      throw new ValueError(
        `accent_color must be a 6-digit hex color, got ${JSON.stringify(normalized)}`
      );
    }
    theme = {
      ...theme,
      accent: normalized,
      accent_light: _mix(normalized, WHITE, 0.88),
    };
  }
  return [name, theme];
}

export function _font_directories(): string[] {
  const directories = [
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    path.join(os.homedir(), ".fonts"),
    path.join(os.homedir(), ".local/share/fonts"),
    "/System/Library/Fonts",
    "/Library/Fonts",
    path.join(os.homedir(), "Library/Fonts"),
  ];
  const windows_root = process.env.WINDIR;
  if (windows_root) directories.push(path.join(windows_root, "Fonts"));
  const local_app_data = process.env.LOCALAPPDATA;
  if (local_app_data) {
    directories.push(path.join(local_app_data, "Microsoft", "Windows", "Fonts"));
  } else {
    directories.push(path.join(os.homedir(), "AppData", "Local", "Microsoft", "Windows", "Fonts"));
  }
  return [
    ...new Set(
      directories.filter(
        (directory) => fs.existsSync(directory) && fs.statSync(directory).isDirectory()
      )
    ),
  ].sort();
}

function _font_style_rank(style: string): number {
  const normalized = style.toLowerCase().replace(/-/g, " ");
  if (["regular", "normal", "roman"].includes(normalized)) return 0;
  if (["book", "medium"].includes(normalized)) return 1;
  return 2;
}

function _font_style_name(style: string): "regular" | "bold" | "italic" | "bold_italic" {
  const normalized = style.toLowerCase().replace(/-/g, " ");
  const is_bold = ["bold", "semibold", "demibold"].some((marker) => normalized.includes(marker));
  const is_italic = ["italic", "oblique"].some((marker) => normalized.includes(marker));
  if (is_bold && is_italic) return "bold_italic";
  if (is_bold) return "bold";
  if (is_italic) return "italic";
  return "regular";
}

function _font_style_choice_rank(style: string, style_name: string): number {
  const normalized = style.toLowerCase().replace(/-/g, " ");
  if (style_name === "regular") return _font_style_rank(style);
  const exact: Record<string, Set<string>> = {
    bold: new Set(["bold"]),
    italic: new Set(["italic", "oblique"]),
    bold_italic: new Set(["bold italic", "bold oblique"]),
  };
  return exact[style_name]?.has(normalized) ? 0 : 1;
}

function _open_font_faces(font_path: string): Array<[string, string, number]> {
  const opened = fontkit.openSync(font_path);
  const fonts = _is_font_collection(opened) ? opened.fonts : [opened];
  return fonts
    .map<[string, string, number] | null>((font, index) => {
      const family = String(font.familyName ?? "").trim();
      const style = String(font.subfamilyName ?? "").trim();
      return family ? [family, style, index] : null;
    })
    .filter((entry): entry is [string, string, number] => entry !== null);
}

const _font_style_catalog_cache = new Map<
  string,
  Record<string, Record<string, [string, number]>>
>();
const _font_catalog_cache = new Map<string, Record<string, FontCatalogEntry>>();

function _walk_font_files(directory: string): string[] {
  const files: string[] = [];
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files.sort();
}

export function _font_style_catalog(): Record<string, Record<string, [string, number]>> {
  const cache_key = _font_directories().join("\0");
  const cached = _font_style_catalog_cache.get(cache_key);
  if (cached) return cached;
  const candidates = new Map<
    string,
    Map<string, { rank: [number, string, number]; source: [string, number] }>
  >();
  for (const directory of _font_directories()) {
    for (const full of _walk_font_files(directory)) {
      const ext = path.extname(full).toLowerCase();
      if (!_FONT_SUFFIXES.has(ext)) continue;
      let faces: Array<[string, string, number]> = [];
      try {
        faces = _open_font_faces(full);
      } catch {
        continue;
      }
      for (const [family, style, face_index] of faces) {
        const family_key = family.toLowerCase();
        const style_name = _font_style_name(style);
        const rank: [number, string, number] = [
          _font_style_choice_rank(style, style_name),
          full.toLowerCase(),
          face_index,
        ];
        const by_style =
          candidates.get(family_key) ??
          new Map<string, { rank: [number, string, number]; source: [string, number] }>();
        const current = by_style.get(style_name);
        if (
          !current ||
          rank[0] < current.rank[0] ||
          (rank[0] === current.rank[0] &&
            (rank[1] < current.rank[1] ||
              (rank[1] === current.rank[1] && rank[2] < current.rank[2])))
        ) {
          by_style.set(style_name, { rank, source: [full, face_index] });
        }
        candidates.set(family_key, by_style);
      }
    }
  }
  const result: Record<string, Record<string, [string, number]>> = {};
  for (const [family, by_style] of candidates.entries()) {
    result[family] = {};
    for (const [style, candidate] of by_style.entries()) {
      result[family][style] = candidate.source;
    }
  }
  _font_style_catalog_cache.set(cache_key, result);
  return result;
}

export function _font_catalog(): Record<string, FontCatalogEntry> {
  const cache_key = _font_directories().join("\0");
  const cached = _font_catalog_cache.get(cache_key);
  if (cached) return cached;
  const candidates = new Map<string, { rank: [number, string, number]; entry: FontCatalogEntry }>();
  for (const directory of _font_directories()) {
    for (const full of _walk_font_files(directory)) {
      const ext = path.extname(full).toLowerCase();
      if (!_FONT_SUFFIXES.has(ext)) continue;
      let faces: Array<[string, string, number]> = [];
      try {
        faces = _open_font_faces(full);
      } catch {
        continue;
      }
      for (const [family, style, face_index] of faces) {
        const key = family.toLowerCase();
        const rank: [number, string, number] = [
          _font_style_rank(style),
          full.toLowerCase(),
          face_index,
        ];
        const existing = candidates.get(key);
        const entry_value: FontCatalogEntry = [family, full, face_index];
        if (
          !existing ||
          rank[0] < existing.rank[0] ||
          (rank[0] === existing.rank[0] &&
            (rank[1] < existing.rank[1] ||
              (rank[1] === existing.rank[1] && rank[2] < existing.rank[2])))
        ) {
          candidates.set(key, { rank, entry: entry_value });
        }
      }
    }
  }
  const result: Record<string, FontCatalogEntry> = {};
  for (const [key, value] of candidates.entries()) result[key] = value.entry;
  _font_catalog_cache.set(cache_key, result);
  return result;
}

function _dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function _font_fallbacks(role: string, requested: string): string[] {
  if (role === "mono") return _MONO_FALLBACKS;
  if (_SERIF_FAMILIES.has(requested.toLowerCase())) return _SERIF_FALLBACKS;
  return _SANS_FALLBACKS;
}

export function _resolve_font(
  role: string,
  requested: string,
  catalog?: Record<string, FontCatalogEntry>
): FontChoice {
  const available = catalog ?? _font_catalog();
  const styles = catalog ? {} : _font_style_catalog();
  const candidates = _dedupe([requested, ..._font_fallbacks(role, requested)]);
  for (const candidate of candidates) {
    const match = available[candidate.toLowerCase()];
    if (!match) continue;
    const resolved = match[0];
    const metrics_path = match[1];
    const metrics_face_index = match[2] ?? 0;
    const metrics_styles = { ...(styles[resolved.toLowerCase()] ?? {}) };
    if (metrics_path) metrics_styles.regular ??= [metrics_path, metrics_face_index];
    if (!catalog) {
      const style_keys = new Set(Object.keys(metrics_styles));
      if (!["regular", "bold", "italic", "bold_italic"].every((key) => style_keys.has(key))) {
        continue;
      }
    }
    return {
      role,
      requested,
      resolved,
      substituted: resolved.toLowerCase() !== requested.toLowerCase(),
      verified: true,
      metrics_path,
      metrics_face_index,
      metrics_styles,
    };
  }
  return {
    role,
    requested,
    resolved: requested,
    substituted: false,
    verified: false,
    metrics_path: null,
    metrics_face_index: 0,
    metrics_styles: null,
  };
}

export function parse_options(spec: Record<string, unknown>): Options {
  const design = _parse_deck_design(spec);
  if (_opt_str(spec, "accent_color") && design.palette.accent) {
    throw new ValueError("accent_color cannot be combined with design.palette.accent");
  }
  const [theme_name, theme] = _resolve_theme(spec);
  const output_path = _opt_str(spec, "output_path");
  if (!output_path) throw new ValueError("output_path is required in the generator spec");

  const heading_choice = _resolve_font("heading", theme.heading_font);
  const body_choice = _resolve_font("body", theme.body_font);
  const mono_choice = _resolve_font("mono", theme.mono_font);
  const resolved_theme: Theme = {
    accent: theme.accent,
    accent_light: theme.accent_light,
    text_dark: theme.text_dark,
    text_muted: theme.text_muted,
    heading_font: heading_choice.resolved,
    body_font: body_choice.resolved,
    mono_font: mono_choice.resolved,
  };

  return {
    theme_name,
    theme: resolved_theme,
    palette: _derive_palette(resolved_theme),
    font_plan: [heading_choice, body_choice, mono_choice],
    title: _opt_str(spec, "title"),
    subtitle: _opt_str(spec, "subtitle"),
    author: _opt_str(spec, "author"),
    date: _opt_str(spec, "date"),
    footer_text: _opt_str(spec, "footer_text"),
    slide_numbers: Boolean(spec.slide_numbers ?? true),
    line_break_mode: _opt_enum(
      spec,
      "line_break_mode",
      ["preserve", "commonmark"] as const,
      "preserve"
    ),
    output_path,
    staging_path: _opt_str(spec, "staging_path"),
    project_root: _opt_str(spec, "project_root") ?? process.cwd(),
    design,
    allowed_image_roots: _parse_allowed_image_roots(spec),
  };
}

export function _normalize_bullet(item: unknown): NormalizedBullet {
  if (typeof item === "string") {
    return { text: item, level: 0, bold: false };
  }
  if (isRecord(item) && "text" in item) {
    const level = Math.max(0, Math.min(2, Number(item.level ?? 0)));
    return { text: String(item.text), level, bold: Boolean(item.bold) };
  }
  throw new ValueError(`invalid bullet item: ${JSON.stringify(item)}`);
}

export function _body_parts(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return String(value)
    .split(PARAGRAPH_SPLIT_RE)
    .filter((part) => part.length > 0);
}

function _normalize_column(column: unknown, label: string): NormalizedColumn {
  if (column === undefined || column === null) {
    return { heading: null, body: null, body_parts: [], bullets: [] };
  }
  const record = asRecord(column, label);
  const bullets =
    record.bullets === undefined
      ? []
      : _optional_array(record.bullets, `${label}.bullets`).map(_normalize_bullet);
  return {
    ...record,
    heading: record.heading ?? null,
    body: record.body ?? null,
    body_parts: _body_parts(record.body),
    bullets,
  };
}

export function normalize_slide(raw: unknown): NormalizedSlide {
  const slide = asRecord(raw, "slide");
  const layout = String(slide.layout ?? "content");
  if (!_is_layout(layout)) {
    throw new ValueError(
      `layout must be one of ${JSON.stringify(LAYOUTS)}, got ${JSON.stringify(layout)}`
    );
  }
  if (_is_composed_layout(layout)) {
    const allowed = new Set([
      "layout",
      "title",
      "kicker",
      "body",
      "bullets",
      "notes",
      "caption",
      "design",
      "media",
    ]);
    const unknown = Object.keys(slide)
      .filter((key) => !allowed.has(key))
      .sort();
    if (unknown.length > 0) {
      throw new ValueError(
        `${layout} contains incompatible or unknown content fields: ${JSON.stringify(unknown)}`
      );
    }
    if (!("media" in slide) || slide.media === null)
      throw new ValueError(`${layout} requires media`);
  } else if ("media" in slide) {
    throw new ValueError("slide.media is supported only by composed image layouts");
  }

  const normalized: NormalizedSlide = {
    ...slide,
    layout,
    body: slide.body !== undefined && slide.body !== null ? String(slide.body) : null,
    bullets:
      slide.bullets === undefined
        ? []
        : _optional_array(slide.bullets, "slide.bullets").map(_normalize_bullet),
    _design_patch: _parse_slide_design(slide),
  };
  if (_is_composed_layout(layout)) {
    normalized._media = _parse_media(
      slide.media,
      "slide.media",
      layout === "full_bleed" ? "crop" : "contain"
    );
  }
  if ("body_parts" in slide) {
    normalized.body_parts = _string_array(slide.body_parts, "slide.body_parts");
  } else if (normalized.body !== null) {
    normalized.body_parts = _body_parts(normalized.body);
  }
  if (layout === "two_column") {
    normalized.left = _normalize_column(slide.left, "slide.left");
    normalized.right = _normalize_column(slide.right, "slide.right");
  }
  return normalized;
}

function _has_path_traversal(value: string): boolean {
  return value.replace(/\\/g, "/").split("/").includes("..");
}

function _reject_nonlocal_asset_path(value: string, label: string): void {
  const stripped = value.trim();
  const is_drive_path = /^[A-Za-z]:[\\/]/.test(stripped);
  if (is_drive_path && process.platform !== "win32") {
    throw new ValueError(`${label} must be a local path, not a URI or drive path`);
  }
  if (!is_drive_path && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(stripped)) {
    throw new ValueError(`${label} must be a local path, not a URI or drive path`);
  }
  if (stripped.startsWith("//") || stripped.startsWith("\\\\")) {
    throw new ValueError(`${label} must not be a network path`);
  }
  if (_has_path_traversal(stripped)) {
    throw new ValueError(`${label} must not contain path traversal`);
  }
}

function _canonical_allowed_roots(opts: Options): string[] {
  const root_values = [opts.project_root, ...opts.allowed_image_roots];
  const roots: string[] = [];
  root_values.forEach((value, index) => {
    _reject_nonlocal_asset_path(value, `allowed image root ${index}`);
    let candidate = path.resolve(value);
    if (!path.isAbsolute(value) && index !== 0) {
      candidate = path.resolve(opts.project_root, value);
    }
    let canonical: string;
    try {
      canonical = fs.realpathSync(candidate);
    } catch {
      throw new ValueError(`allowed image root ${index} does not exist`);
    }
    if (!fs.statSync(canonical).isDirectory()) {
      throw new ValueError(`allowed image root ${index} must be a directory`);
    }
    if (!roots.includes(canonical)) roots.push(canonical);
  });
  return roots;
}

function _is_within(candidate: string, roots: string[]): boolean {
  for (const root of roots) {
    const relative = path.relative(root, candidate);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return true;
    }
  }
  return false;
}

export function _read_asset_snapshot(asset_path: string, label: string): Buffer {
  let before: fs.Stats;
  try {
    before = fs.statSync(asset_path, { bigint: false });
  } catch {
    throw new ValueError(`${label} asset is missing or unreadable`);
  }
  if (!before.isFile()) throw new ValueError(`${label} asset must be a regular file`);
  if (before.size > NEW_ASSET_MAX_BYTES) {
    throw new ValueError(`${label} asset exceeds the 25 MiB source limit`);
  }

  let flags = fs.constants.O_RDONLY;
  for (const constant_name of ["O_BINARY", "O_NOFOLLOW"]) {
    const value: unknown = Reflect.get(fs.constants, constant_name);
    if (value === undefined) continue;
    if (typeof value !== "number") {
      throw new ValueError(`filesystem constant ${constant_name} must be numeric when present`);
    }
    flags |= value;
  }
  let fd: number;
  try {
    fd = fs.openSync(asset_path, flags);
  } catch {
    throw new ValueError(`${label} asset is missing or unreadable`);
  }
  let opened: fs.Stats;
  let after: fs.Stats;
  try {
    opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new ValueError(`${label} asset must be a regular file`);
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const bytes_read = fs.readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, NEW_ASSET_MAX_BYTES + 1 - total),
        null
      );
      if (bytes_read <= 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytes_read)));
      total += bytes_read;
      if (total > NEW_ASSET_MAX_BYTES) {
        throw new ValueError(`${label} asset exceeds the 25 MiB source limit`);
      }
    }
    after = fs.fstatSync(fd);
    const identity_before = [before.dev, before.ino, before.size, before.mtimeMs].join(":");
    const identity_opened = [opened.dev, opened.ino, opened.size, opened.mtimeMs].join(":");
    const identity_after = [after.dev, after.ino, after.size, after.mtimeMs].join(":");
    if (identity_before !== identity_opened || identity_opened !== identity_after) {
      throw new ValueError(`${label} asset changed during preflight`);
    }
    const payload = Buffer.concat(chunks);
    if (payload.length !== after.size) {
      throw new ValueError(`${label} asset changed during preflight`);
    }
    return payload;
  } finally {
    fs.closeSync(fd);
  }
}

function _pixel_limit_exceeded(width_px: number, height_px: number): boolean {
  if (!Number.isSafeInteger(width_px) || !Number.isSafeInteger(height_px)) return true;
  return BigInt(width_px) * BigInt(height_px) > BigInt(NEW_ASSET_MAX_PIXELS);
}

function _probe_asset_dimensions(
  payload: Uint8Array,
  label: string
): Pick<PreparedAsset, "width_px" | "height_px" | "image_format"> {
  let probed: ReturnType<typeof imageSize>;
  try {
    probed = imageSize(payload);
  } catch {
    throw new ValueError(`${label} asset is missing, corrupt, or unsupported`);
  }
  const image_format =
    probed.type === "png" ? "PNG" : probed.type === "jpg" || probed.type === "jpeg" ? "JPEG" : null;
  if (!image_format) {
    throw new ValueError(`${label} asset must be a static PNG or JPEG`);
  }
  const width_px = Number(probed.width ?? 0);
  const height_px = Number(probed.height ?? 0);
  if (
    !Number.isInteger(width_px) ||
    !Number.isInteger(height_px) ||
    width_px <= 0 ||
    height_px <= 0
  ) {
    throw new ValueError(`${label} asset dimensions must be positive`);
  }
  if (_pixel_limit_exceeded(width_px, height_px)) {
    throw new ValueError(`${label} asset exceeds the 40,000,000 pixel limit`);
  }
  return { width_px, height_px, image_format };
}

export async function _decode_asset_snapshot(
  payload: Buffer,
  label: string
): Promise<PreparedAsset> {
  const probed = _probe_asset_dimensions(payload, label);
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(payload, {
      animated: true,
      limitInputPixels: false,
    }).metadata();
  } catch {
    throw new ValueError(`${label} asset is missing, corrupt, or unsupported`);
  }
  if (metadata.pages && metadata.pages > 1) {
    throw new ValueError(`${label} animated assets are not supported`);
  }
  try {
    const pipeline = sharp(payload, {
      animated: false,
      limitInputPixels: NEW_ASSET_MAX_PIXELS,
    }).rotate();
    let encoded: Buffer;
    if (probed.image_format === "JPEG") {
      encoded = await pipeline.jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
      return { payload: encoded, ...probed };
    }
    encoded = await pipeline.png().toBuffer();
    return { payload: encoded, ...probed };
  } catch {
    throw new ValueError(`${label} asset is missing, corrupt, or unsupported`);
  }
}

async function _prepare_asset(
  path_value: string,
  label: string,
  opts: Options,
  roots: string[],
  cache: Map<string, PreparedAsset>
): Promise<PreparedAsset> {
  _reject_nonlocal_asset_path(path_value, label);
  const suffix = path.extname(path_value).toLowerCase();
  if (![".png", ".jpg", ".jpeg"].includes(suffix)) {
    throw new ValueError(`${label} asset must use a .png, .jpg, or .jpeg extension`);
  }
  const candidate = path.isAbsolute(path_value)
    ? path.resolve(path_value)
    : path.resolve(opts.project_root, path_value);
  let canonical: string;
  try {
    canonical = fs.realpathSync(candidate);
  } catch {
    throw new ValueError(`${label} asset is missing or unreadable`);
  }
  if (!_is_within(canonical, roots)) {
    throw new ValueError(`${label} asset escapes the allowed image roots`);
  }
  if (!cache.has(canonical)) {
    cache.set(
      canonical,
      await _decode_asset_snapshot(_read_asset_snapshot(canonical, label), label)
    );
  }
  const prepared = cache.get(canonical);
  if (!prepared) throw new ValueError(`${label} asset could not be prepared`);
  return prepared;
}

async function _prepare_media(
  media: MediaSpec | null,
  label: string,
  opts: Options,
  roots: string[],
  cache: Map<string, PreparedAsset>
): Promise<MediaSpec | null> {
  if (!media) return null;
  return { ...media, asset: await _prepare_asset(media.path, label, opts, roots, cache) };
}

async function _prepare_mark(
  mark: PlacedImage | null,
  label: string,
  opts: Options,
  roots: string[],
  cache: Map<string, PreparedAsset>
): Promise<PlacedImage | null> {
  if (!mark) return null;
  return { ...mark, asset: await _prepare_asset(mark.path, label, opts, roots, cache) };
}

export async function _preflight_new_assets(
  opts: Options,
  slides: NormalizedSlide[]
): Promise<[Options, NormalizedSlide[]]> {
  if (
    !(
      opts.design.supplied ||
      opts.allowed_image_roots.length > 0 ||
      slides.some(
        (slide) => _is_composed_layout(slide.layout) || _slide_design_patch(slide, "slide").supplied
      )
    )
  ) {
    return [opts, slides];
  }
  const roots = _canonical_allowed_roots(opts);
  const cache = new Map<string, PreparedAsset>();
  const deck_design: DesignDefaults = {
    ...opts.design,
    background: await _prepare_media(opts.design.background, "deck background", opts, roots, cache),
    mark: await _prepare_mark(opts.design.mark, "deck mark", opts, roots, cache),
  };
  const prepared_slides: NormalizedSlide[] = [];
  for (let index = 0; index < slides.length; index += 1) {
    const slide = _defined_at(slides, index, "normalized slide");
    const patch = _slide_design_patch(slide, `slide ${index + 1}`);
    const prepared: NormalizedSlide = { ...slide };
    prepared._design_patch = {
      ...patch,
      background: await _prepare_media(
        patch.background,
        `slide ${index + 1} background`,
        opts,
        roots,
        cache
      ),
      mark: await _prepare_mark(patch.mark, `slide ${index + 1} mark`, opts, roots, cache),
    };
    if (prepared._media) {
      const media = _media_spec_or_null(prepared, "_media", `slide ${index + 1}`);
      prepared._media =
        (await _prepare_media(media, `slide ${index + 1} media`, opts, roots, cache)) ?? undefined;
    }
    prepared_slides.push(prepared);
  }
  return [{ ...opts, design: deck_design }, prepared_slides];
}

export function _resolve_design(opts: Options, page: Record<string, unknown>): ResolvedDesign {
  const patch = _slide_design_patch(page, "slide");
  const requested = _merge_palette_patch(opts.design.palette, patch.palette);
  const active = opts.design.supplied || patch.supplied || _is_composed_layout(String(page.layout));
  const [palette, corrections] = active
    ? _derive_design_palette(opts.palette, requested)
    : [opts.palette, []];
  let background = opts.design.background;
  if (patch.background_is_set) background = patch.background;
  let mark = opts.design.mark;
  if (patch.mark_is_set) mark = patch.mark;
  const replaced = String(page.layout) === "full_bleed" && background !== null;
  if (String(page.layout) === "full_bleed") background = null;
  return {
    palette,
    background,
    mark,
    active,
    requested_palette: requested,
    corrections,
    background_replaced_by_media: replaced,
  };
}

function _contrast_record(foreground: string, background: string): Record<string, unknown> {
  return {
    foreground,
    background,
    ratio: Math.round(_contrast_ratio(foreground, background) * 10000) / 10000,
  };
}

function _semantic_palette_record(palette: Palette): Record<string, string> {
  return {
    canvas: palette.background,
    surface: palette.surface,
    surface_alt: palette.surface_alt,
    accent: palette.accent,
    text: palette.text,
    muted_text: palette.text_muted,
    heading: palette.heading,
    accent_text: palette.accent_text,
    accent_soft: palette.accent_soft,
    on_accent: palette.on_accent,
    link: palette.link,
    link_on_accent: palette.link_on_accent,
    border: palette.border,
    code_background: palette.code_background,
    code_text: palette.code_text,
    canvas_text: palette.canvas_text,
    canvas_muted_text: palette.canvas_text_muted,
  };
}

function _resolved_design_record(
  design: ResolvedDesign,
  page?: Record<string, unknown>,
  output_slide_index?: number
): Record<string, unknown> {
  const palette = design.palette;
  const contrast_roles = {
    surface_text: _contrast_record(palette.text, palette.surface),
    surface_muted_text: _contrast_record(palette.text_muted, palette.surface),
    surface_heading: _contrast_record(palette.heading, palette.surface),
    surface_link: _contrast_record(palette.link, palette.surface),
    surface_accent_text: _contrast_record(palette.accent_text, palette.surface),
    alternate_surface_text: _contrast_record(palette.text, palette.surface_alt),
    alternate_surface_muted_text: _contrast_record(palette.text_muted, palette.surface_alt),
    alternate_surface_link: _contrast_record(palette.link, palette.surface_alt),
    code_text: _contrast_record(palette.code_text, palette.code_background),
    canvas_text: _contrast_record(palette.canvas_text, palette.background),
    canvas_muted_text: _contrast_record(palette.canvas_text_muted, palette.background),
    on_accent: _contrast_record(palette.on_accent, palette.accent),
    link_on_accent: _contrast_record(palette.link_on_accent, palette.accent),
  };
  const record: Record<string, unknown> = {
    active: design.active,
    palette: _semantic_palette_record(palette),
    contrast_roles,
    background: {
      present: design.background !== null,
      fit: design.background?.fit ?? null,
      overlay_present: Boolean(design.background?.overlay),
    },
    mark: {
      present: design.mark !== null,
      fit: design.mark?.fit ?? null,
    },
    corrections: design.corrections.map((correction) => ({ ...correction })),
    requested_palette: Object.fromEntries(
      Object.entries(design.requested_palette).filter(
        ([, value]) => value !== null && value !== undefined
      )
    ),
    background_replaced_by_media: design.background_replaced_by_media,
  };
  if (page) {
    const media = _media_spec_or_null(page, "_media", "slide");
    record.output_slide_index = output_slide_index ?? null;
    record.source_slide_index = Number(page._origin_index ?? 0) + 1;
    record.source_layout = page._source_layout ?? page.layout ?? null;
    record.layout = page.layout ?? null;
    record.continuation_index = Number(page._continuation_index ?? 0);
    record.media = {
      present: media !== null,
      fit: media?.fit ?? null,
      overlay_present: Boolean(media?.overlay),
    };
  }
  return record;
}

function _validate_inline_html(content: string): boolean {
  if (BR_TAG_RE.test(content.trim())) return true;
  if (HTML_IMAGE_RE.test(content)) {
    throw new ValueError(
      "inline image in raw HTML is not supported; place the image in its own paragraph"
    );
  }
  throw new ValueError("unsupported inline HTML is not supported on slides");
}

function _child_href(token: MarkdownTokenContract): string {
  return tokenAttr(token, "href") ?? "";
}

function _contains_image(children: MarkdownTokenContract[]): boolean {
  return children.some((token) => token.type === "image");
}

function _inline_markup(inline: MarkdownTokenContract, context: string): string {
  const children = _token_children(inline, context);
  if (_contains_image(children)) {
    throw new ValueError(
      `inline image mixed with text is not supported in ${context}; place the image in its own paragraph`
    );
  }
  for (const child of children) {
    if (child.type === "html_inline") _validate_inline_html(child.content);
  }
  return inline.content;
}

function _is_image_only(
  children: MarkdownTokenContract[]
): [boolean, MarkdownTokenContract | null] {
  const meaningful = children.filter(
    (token) => !(token.type === "text" && token.content.trim() === "")
  );
  if (meaningful.length === 1 && meaningful[0]?.type === "image") {
    return [true, meaningful[0]];
  }
  return [false, null];
}

class _MarkdownSlicer {
  meta: Options;
  slides: Array<Record<string, unknown>> = [];
  current: MarkdownDraft | null = null;
  section_pending = false;
  warnings: string[] = [];

  constructor(meta: Options) {
    this.meta = meta;
  }

  static _blank(title: string | null = null): MarkdownDraft {
    return { title, bullets: [], body_parts: [], images: [], code_parts: [], tables: [] };
  }

  slice(tokens: MarkdownTokenContract[]): Array<Record<string, unknown>> {
    let i = this._maybe_title_slide(tokens);
    while (i < tokens.length) {
      i = this._consume(tokens, i);
    }
    this._finalize();
    if (this.slides.length === 0 || this.slides[0]?.layout !== "title") {
      if (this.meta.title) this.slides.unshift({ layout: "title", title: this.meta.title });
    }
    return this.slides;
  }

  _maybe_title_slide(tokens: MarkdownTokenContract[]): number {
    if (tokens[0]?.type === "heading_open" && tokens[0]?.tag === "h1") {
      const slide: Record<string, unknown> = {
        layout: "title",
        title: _inline_markup(_token_at(tokens, 1, "title token"), "title"),
      };
      let i = 3;
      if (tokens[i]?.type === "paragraph_open") {
        const subtitle_token = _token_at(tokens, i + 1, "subtitle token");
        const children = _token_children(subtitle_token, "subtitle token");
        const [only_image] = _is_image_only(children);
        if (!only_image) {
          const subtitle = _inline_markup(subtitle_token, "subtitle");
          if (subtitle) {
            slide.subtitle = subtitle;
            i += 3;
          }
        }
      }
      this.slides.push(slide);
      return i;
    }
    return 0;
  }

  _consume(tokens: MarkdownTokenContract[], i: number): number {
    const token = _token_at(tokens, i, "markdown token");
    if (token.type === "hr") {
      this.section_pending = true;
      return i + 1;
    }
    if (token.type === "heading_open") return this._heading(tokens, i);
    this.section_pending = false;
    if (token.type === "paragraph_open") return this._paragraph(tokens, i);
    if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
      return this._list(tokens, i, 0);
    }
    if (token.type === "blockquote_open") return this._blockquote(tokens, i);
    if (token.type === "table_open") return this._table(tokens, i);
    if (token.type === "fence" || token.type === "code_block") {
      this._slide().code_parts.push(token.content);
      return i + 1;
    }
    if (token.type === "html_block") {
      if (HTML_IMAGE_RE.test(token.content)) {
        throw new ValueError(
          "inline image in raw HTML is not supported; place the image in its own paragraph"
        );
      }
      throw new ValueError("unsupported HTML block is not supported on slides");
    }
    return i + 1;
  }

  _slide(): MarkdownDraft {
    if (!this.current) this.current = _MarkdownSlicer._blank();
    return this.current;
  }

  _heading(tokens: MarkdownTokenContract[], i: number): number {
    const level = Number(_token_at(tokens, i, "heading open token").tag.slice(1));
    const text = _inline_markup(_token_at(tokens, i + 1, "heading token"), "heading");
    const pending = this.section_pending;
    this.section_pending = false;
    if (level <= 2) {
      this._finalize();
      if (pending && level === 2) {
        this.slides.push({ layout: "section", title: text });
      } else {
        this.current = _MarkdownSlicer._blank(text);
      }
    } else {
      this._slide().bullets.push({
        text,
        level: 0,
        bold: true,
      });
    }
    return i + 3;
  }

  _paragraph(tokens: MarkdownTokenContract[], i: number): number {
    const inline = _token_at(tokens, i + 1, "paragraph inline token");
    const children = _token_children(inline, "paragraph inline token");
    const [only_image, image_token] = _is_image_only(children);
    if (only_image && image_token) {
      this._slide().images.push({
        path: tokenAttr(image_token, "src") ?? "",
        caption: image_token.content || null,
      });
    } else {
      if (_contains_image(children)) {
        throw new ValueError("inline image mixed with surrounding text is not supported on slides");
      }
      this._slide().body_parts.push(inline.content);
    }
    return i + 3;
  }

  _list(tokens: MarkdownTokenContract[], i: number, depth: number): number {
    const close = _token_at(tokens, i, "list open token").type.replace("_open", "_close");
    i += 1;
    while (_token_at(tokens, i, "list token").type !== close) {
      if (_token_at(tokens, i, "list token").type === "list_item_open") {
        i = this._list_item(tokens, i, depth);
      } else {
        i += 1;
      }
    }
    return i + 1;
  }

  _list_item(tokens: MarkdownTokenContract[], i: number, depth: number): number {
    i += 1;
    while (_token_at(tokens, i, "list item token").type !== "list_item_close") {
      const token = _token_at(tokens, i, "list item token");
      if (token.type === "paragraph_open") {
        const inline = _token_at(tokens, i + 1, "list item inline token");
        const children = _token_children(inline, "list item inline token");
        const [only_image] = _is_image_only(children);
        if (only_image) {
          throw new ValueError(
            "image-only bullet items are not supported in markdown list content"
          );
        }
        if (_contains_image(children)) {
          throw new ValueError(
            "inline image mixed with surrounding text is not supported on slides"
          );
        }
        this._slide().bullets.push({
          text: inline.content,
          level: Math.min(depth, 2),
          bold: false,
        });
        i += 3;
      } else if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
        i = this._list(tokens, i, depth + 1);
      } else {
        i += 1;
      }
    }
    return i + 1;
  }

  _blockquote(tokens: MarkdownTokenContract[], i: number): number {
    const parts: string[] = [];
    while (_token_at(tokens, i, "blockquote token").type !== "blockquote_close") {
      const token = _token_at(tokens, i, "blockquote token");
      if (token.type === "inline") parts.push(token.content);
      i += 1;
    }
    let text = parts.join("\n").trim();
    let attribution: string | null = null;
    const lines = text.split("\n");
    if (
      lines.length > 1 &&
      (lines.at(-1)?.trimStart().startsWith("—") || lines.at(-1)?.trimStart().startsWith("--"))
    ) {
      attribution = (lines.at(-1) ?? "")
        .trimStart()
        .replace(/^[—-]+/, "")
        .trim();
      text = lines.slice(0, -1).join("\n").trim();
    }
    const slide = this._slide();
    if (!("quote" in slide) && slide.bullets.length === 0 && slide.body_parts.length === 0) {
      slide.quote = text;
      slide.attribution = attribution;
    } else {
      slide.body_parts.push(text);
    }
    return i + 1;
  }

  _table(tokens: MarkdownTokenContract[], i: number): number {
    let headers: string[] = [];
    const rows: string[][] = [];
    let row: string[] = [];
    let in_head = false;
    while (_token_at(tokens, i, "table token").type !== "table_close") {
      const token = _token_at(tokens, i, "table token");
      if (token.type === "thead_open") in_head = true;
      else if (token.type === "thead_close") in_head = false;
      else if (token.type === "tr_open") row = [];
      else if (token.type === "inline") row.push(token.content);
      else if (token.type === "tr_close") {
        if (in_head) headers = row;
        else rows.push(row);
      }
      i += 1;
    }
    this._slide().tables.push({ headers, rows });
    return i + 1;
  }

  _finalize(): void {
    const slide = this.current;
    this.current = null;
    if (!slide) return;
    this.slides.push(...this._materialize(slide));
  }

  _materialize(slide: MarkdownDraft): Array<Record<string, unknown>> {
    const title = slide.title;
    const body_parts = [...slide.body_parts];
    const bullets = [...slide.bullets];
    const tables = [...slide.tables];
    const code_parts = [...slide.code_parts];

    const pages: Array<Record<string, unknown>> = [];
    if (slide.quote) {
      pages.push({
        layout: "quote",
        title,
        quote: slide.quote,
        attribution: slide.attribution ?? null,
      });
    }

    const body_on_table = tables.length > 0 && bullets.length === 0 && code_parts.length === 0;
    if (bullets.length > 0 || code_parts.length > 0 || (body_parts.length > 0 && !body_on_table)) {
      pages.push({
        layout: "content",
        title: pages.length === 0 ? title : null,
        kicker: null,
        body_parts,
        body: body_parts.length > 0 ? body_parts.join("\n\n") : null,
        code_parts,
        code: code_parts,
        bullets,
        code_lines: null,
      });
    }

    tables.forEach((table, index) => {
      const table_body_parts = body_on_table && index === 0 ? body_parts : [];
      pages.push({
        layout: "table",
        title: pages.length === 0 ? title : null,
        table,
        body_parts: table_body_parts,
        body: table_body_parts.length > 0 ? table_body_parts.join("\n\n") : null,
      });
    });

    for (const image of slide.images) {
      pages.push({
        layout: "image",
        title: pages.length === 0 ? title : null,
        image_path: image.path,
        caption: image.caption ?? null,
      });
    }

    if (pages.length === 0 && title) {
      pages.push({ layout: "content", title, body_parts: [], bullets: [] });
    }
    return pages;
  }
}

export function markdown_to_slides(markdown: string, meta: Options): [NormalizedSlide[], string[]] {
  const parser = new MarkdownIt("commonmark").enable(["table", "strikethrough"]);
  const tokens = _markdown_tokens(parser, markdown, false, "markdown parser output");
  const slicer = new _MarkdownSlicer(meta);
  const slides = slicer.slice(tokens).map((slide) => normalize_slide(slide));
  return [slides, slicer.warnings];
}

export function _visible_lines(
  text: string,
  line_break_mode: Options["line_break_mode"]
): string[] {
  const tokens = _markdown_tokens(_MD_INLINE, text, true, "inline markdown parser output");
  const first = tokens[0];
  const children = first ? _token_children(first, "inline markdown root token") : [];
  const segments: string[] = [];
  let current = "";
  for (const token of children) {
    if (token.type === "text" || token.type === "code_inline") {
      current += token.content;
    } else if (token.type === "softbreak") {
      if (line_break_mode === "preserve") {
        segments.push(current);
        current = "";
      } else {
        current += " ";
      }
    } else if (token.type === "hardbreak") {
      segments.push(current);
      current = "";
    } else if (token.type === "html_inline") {
      if (_validate_inline_html(token.content)) {
        segments.push(current);
        current = "";
      }
    } else if (token.type === "image") {
      throw new ValueError(
        "inline image mixed with text is not supported; place the image in its own paragraph"
      );
    }
  }
  segments.push(current);
  return segments.length > 0 ? segments : [""];
}

function _fallback_visual_units(text: string): number {
  let units = 0.0;
  for (const character of [...text]) {
    if (/\p{Mark}/u.test(character)) continue;
    units +=
      /[\u1100-\u115F\u2329\u232A\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/u.test(
        character
      )
        ? 2.0
        : 1.0;
  }
  return units;
}

const FONT_OBJECT_CACHE = new Map<string, OpenFont | null>();
const FONT_MEASURE_CACHE = new Map<string, number>();

function _font_cache_key(source: FontMetricSource): string {
  if (!source) return "none";
  if (typeof source === "string") return source;
  if (Array.isArray(source)) return `${source[0]}#${source[1]}`;
  return JSON.stringify(source);
}

function _open_font(source: FontMetricTuple | string): OpenFont | null {
  const tuple: FontMetricTuple = typeof source === "string" ? [source, 0] : source;
  const key = `${tuple[0]}#${tuple[1]}`;
  if (FONT_OBJECT_CACHE.has(key)) return FONT_OBJECT_CACHE.get(key) ?? null;
  try {
    const opened = fontkit.openSync(tuple[0]);
    const selected = _is_font_collection(opened) ? (opened.fonts[tuple[1] ?? 0] ?? null) : opened;
    FONT_OBJECT_CACHE.set(key, selected);
    return selected;
  } catch {
    FONT_OBJECT_CACHE.set(key, null);
    return null;
  }
}

function _font_for_metrics(
  source: FontMetricSource,
  _font_pt: number,
  style = "regular"
): OpenFont | null {
  if (!source) return null;
  let selected: FontMetricTuple | string | null;
  if (_is_font_metric_plan(source)) {
    selected = style === "regular" ? source.regular : (source.styles[style] ?? null);
    if (!selected) return null;
  } else {
    selected = source;
  }
  return _open_font(selected);
}

function _measure_character(
  character: string,
  source: FontMetricSource,
  font_pt: number,
  average: number,
  style = "regular"
): number {
  const cache_key = `${_font_cache_key(source)}|${style}|${font_pt}|${character}`;
  const cached = FONT_MEASURE_CACHE.get(cache_key);
  if (cached !== undefined) return cached;
  const font = _font_for_metrics(source, font_pt, style);
  let width: number;
  if (font) {
    const pixel_size = Math.max(1, Math.round((font_pt * PIXELS_PER_INCH) / POINTS_PER_INCH));
    const run = font.layout(character);
    const advance = (run.positions as Array<{ xAdvance: number }>).reduce(
      (sum, position) => sum + Number(position.xAdvance ?? 0),
      0
    );
    width = (advance / Number(font.unitsPerEm || 1000)) * pixel_size;
  } else {
    width = _fallback_visual_units(character) * average;
  }
  FONT_MEASURE_CACHE.set(cache_key, width);
  return width;
}

function _wrap_overwide_token(
  token: string,
  current_width: number,
  max_width: number,
  measure: (value: string) => number
): [number, number] {
  let completed_lines = current_width ? 1 : 0;
  current_width = 0.0;
  for (const character of [...token]) {
    const character_width = measure(character);
    if (current_width && current_width + character_width > max_width) {
      completed_lines += 1;
      current_width = 0.0;
    }
    if (character_width > max_width) completed_lines += 1;
    else current_width += character_width;
  }
  return [completed_lines, current_width];
}

export function _segment_line_count(
  segment: string,
  width_in: number,
  font_pt: number,
  font_source: FontMetricSource
): number {
  if (!segment) return 1;
  const max_width = Math.max(1.0, width_in * PIXELS_PER_INCH);
  const average_character_width = (font_pt * 0.58 * PIXELS_PER_INCH) / POINTS_PER_INCH;
  const font = _font_for_metrics(font_source, font_pt);
  const measure = (value: string): number => {
    if (font) {
      const pixel_size = Math.max(1, Math.round((font_pt * PIXELS_PER_INCH) / POINTS_PER_INCH));
      const run = font.layout(value);
      const advance = (run.positions as Array<{ xAdvance: number }>).reduce(
        (sum, position) => sum + Number(position.xAdvance ?? 0),
        0
      );
      return (advance / Number(font.unitsPerEm || 1000)) * pixel_size;
    }
    return _fallback_visual_units(value) * average_character_width;
  };
  let line_count = 0;
  let current_width = 0.0;
  let pending_space = 0.0;
  for (const token of segment.match(/\S+|[ \t]+/g) ?? []) {
    if (/^[ \t]+$/.test(token)) {
      pending_space = measure(token);
      continue;
    }
    const word_width = measure(token);
    const separator_width = current_width ? pending_space : 0.0;
    pending_space = 0.0;
    if (word_width <= max_width) {
      if (current_width && current_width + separator_width + word_width > max_width) {
        line_count += 1;
        current_width = word_width;
      } else {
        current_width += separator_width + word_width;
      }
      continue;
    }
    const [completed, next_width] = _wrap_overwide_token(token, current_width, max_width, measure);
    line_count += completed;
    current_width = next_width;
  }
  return Math.max(1, line_count + (current_width ? 1 : 0));
}

function _wrapped_measured_line_count(
  tokens: Array<[number, number, number[]]>,
  max_width: number
): number {
  let line_count = 0;
  let current_width = 0.0;
  for (const [space_width, word_width, character_widths] of tokens) {
    const separator = current_width ? space_width : 0.0;
    if (word_width <= max_width) {
      if (current_width && current_width + separator + word_width > max_width) {
        line_count += 1;
        current_width = word_width;
      } else {
        current_width += separator + word_width;
      }
      continue;
    }
    if (current_width) {
      line_count += 1;
      current_width = 0.0;
    }
    for (const character_width of character_widths) {
      if (current_width && current_width + character_width > max_width) {
        line_count += 1;
        current_width = 0.0;
      }
      if (character_width > max_width) line_count += 1;
      else current_width += character_width;
    }
  }
  return Math.max(1, line_count + (current_width ? 1 : 0));
}

export function _estimate_lines(
  text: string,
  width_in: number,
  font_pt: number,
  line_break_mode: Options["line_break_mode"],
  font_path: FontMetricSource = null,
  mono_font_path: FontMetricSource = null,
  bold = false,
  italic = false
): number {
  const body_source = font_path;
  const mono_source = mono_font_path ?? font_path;
  const average_width = (font_pt * 0.58 * PIXELS_PER_INCH) / POINTS_PER_INCH;
  const mono_average_width = (font_pt * 0.62 * PIXELS_PER_INCH) / POINTS_PER_INCH;
  const logical_lines: Array<Array<[number, number, number[]]>> = [];
  let line_tokens: Array<[number, number, number[]]> = [];
  const word_widths: number[] = [];
  let pending_space_width = 0.0;
  const state = { bold, italic };

  function style_name(): "regular" | "bold" | "italic" | "bold_italic" {
    if (state.bold && state.italic) return "bold_italic";
    if (state.bold) return "bold";
    if (state.italic) return "italic";
    return "regular";
  }

  function measure(character: string, code: boolean): number {
    const style = style_name();
    const source = code ? mono_source : body_source;
    const font = _font_for_metrics(source, font_pt, style);
    if (
      !font &&
      style !== "regular" &&
      source &&
      typeof source === "object" &&
      !Array.isArray(source) &&
      "styles" in source
    ) {
      throw new ValueError(
        `verified ${style.replace(/_/g, "-")} font metrics are unavailable; cannot preflight styled text safely`
      );
    }
    return _measure_character(
      character,
      source,
      font_pt,
      code ? mono_average_width : average_width,
      style
    );
  }

  function flush_word(): void {
    if (word_widths.length > 0) {
      line_tokens.push([
        pending_space_width,
        word_widths.reduce((sum, width) => sum + width, 0),
        [...word_widths],
      ]);
      word_widths.length = 0;
      pending_space_width = 0.0;
    }
  }

  function line_break(): void {
    flush_word();
    logical_lines.push(line_tokens);
    line_tokens = [];
    pending_space_width = 0.0;
  }

  const tokens = _markdown_tokens(_MD_INLINE, text, true, "inline markdown parser output");
  const first = tokens[0];
  const children = first ? _token_children(first, "inline markdown root token") : [];
  for (const token of children) {
    if (token.type === "strong_open") {
      state.bold = true;
      continue;
    }
    if (token.type === "strong_close") {
      state.bold = bold;
      continue;
    }
    if (token.type === "em_open") {
      state.italic = true;
      continue;
    }
    if (token.type === "em_close") {
      state.italic = italic;
      continue;
    }
    if (token.type === "softbreak") {
      if (line_break_mode === "preserve") line_break();
      else {
        flush_word();
        pending_space_width += measure(" ", false);
      }
      continue;
    }
    if (token.type === "hardbreak") {
      line_break();
      continue;
    }
    if (token.type === "html_inline") {
      if (_validate_inline_html(token.content)) line_break();
      continue;
    }
    if (token.type === "image") {
      throw new ValueError(
        "inline image mixed with text is not supported; place the image in its own paragraph"
      );
    }
    if (!["text", "code_inline"].includes(token.type)) continue;
    const is_code = token.type === "code_inline";
    for (const character of [...token.content]) {
      if (/\s/u.test(character)) {
        flush_word();
        pending_space_width += measure(character, is_code);
      } else {
        word_widths.push(measure(character, is_code));
      }
    }
  }
  flush_word();
  logical_lines.push(line_tokens);
  const max_width = Math.max(1.0, width_in * PIXELS_PER_INCH);
  return Math.max(
    1,
    logical_lines.reduce((sum, line) => sum + _wrapped_measured_line_count(line, max_width), 0)
  );
}

export function _plain_line_count(
  text: string,
  width_in: number,
  font_pt: number,
  font_path: FontMetricSource
): number {
  const lines = text.split(/\n/u);
  return Math.max(
    1,
    lines.reduce((sum, line) => sum + _segment_line_count(line, width_in, font_pt, font_path), 0)
  );
}

export function _body_paragraph_height(
  text: string,
  line_break_mode: Options["line_break_mode"],
  font_path: FontMetricSource,
  mono_font_path: FontMetricSource = null,
  width_in = CONTENT_W,
  font_pt = BODY_FONT_PT,
  line_height_in = BODY_LINE_HEIGHT_IN
): number {
  const lines = _estimate_lines(
    text,
    width_in,
    font_pt,
    line_break_mode,
    font_path,
    mono_font_path
  );
  return lines * line_height_in + PARAGRAPH_GAP_IN;
}

export function _bullet_height(
  bullet: Record<string, unknown>,
  sizes: readonly [number, number, number] | number[],
  line_break_mode: Options["line_break_mode"],
  font_path: FontMetricSource,
  mono_font_path: FontMetricSource = null,
  width_in = CONTENT_W * 0.95
): number {
  const level = Math.max(0, Math.min(2, Number(bullet.level ?? 0)));
  const font_pt = Number(sizes[level]);
  const usable_width = Math.max(0.5, width_in - level * 0.28);
  const lines = _estimate_lines(
    String(bullet.text ?? ""),
    usable_width,
    font_pt,
    line_break_mode,
    font_path,
    mono_font_path,
    Boolean(bullet.bold),
    false
  );
  const line_height = (font_pt * BULLET_LINE_HEIGHT_FACTOR) / POINTS_PER_INCH;
  const gap = Math.max(4.0, font_pt * BULLET_GAP_FACTOR) / POINTS_PER_INCH;
  return lines * line_height + gap;
}

export function _code_source_line_height(text: string, font_path: FontMetricSource): number {
  const lines = _plain_line_count(text, CONTENT_W - 0.3, CODE_FONT_PT, font_path);
  return lines * CODE_LINE_HEIGHT_IN;
}

export function _table_row_height(
  row: string[],
  col_width_in: number,
  line_break_mode: Options["line_break_mode"],
  font_path: FontMetricSource,
  mono_font_path: FontMetricSource = null,
  font_pt = TABLE_BODY_FONT_PT,
  minimum = TABLE_MIN_ROW_HEIGHT_IN,
  bold = false
): number {
  const lines = Math.max(
    1,
    ...row.map((value) =>
      _estimate_lines(
        String(value),
        Math.max(0.3, col_width_in - 0.24),
        font_pt,
        line_break_mode,
        font_path,
        mono_font_path,
        bold,
        false
      )
    )
  );
  return Math.max(minimum, lines * TABLE_LINE_HEIGHT_IN + TABLE_CELL_VERTICAL_PADDING_IN);
}

export function _paginate_content(
  title: string | null,
  kicker: string | null,
  body_parts: string[],
  bullets: Array<Record<string, unknown>>,
  code_parts: string[],
  line_break_mode: Options["line_break_mode"],
  body_font_path: FontMetricSource,
  mono_font_path: FontMetricSource,
  options: {
    output_layout?: string;
    content_width?: number;
    content_height?: number;
  } = {}
): Array<Record<string, unknown>> {
  const output_layout = options.output_layout ?? "content";
  const content_width = options.content_width ?? CONTENT_W;
  const content_height = options.content_height ?? CONTENT_HEIGHT;
  const code_lines = code_parts.flatMap((block) => String(block).replace(/\r/g, "").split("\n"));
  if (
    code_lines.length > 0 &&
    code_lines.at(-1) === "" &&
    code_parts.some((block) => block.endsWith("\n"))
  ) {
    code_lines.pop();
  }

  if (body_parts.length === 0 && bullets.length === 0 && code_lines.length === 0) {
    return [
      {
        layout: output_layout,
        title,
        kicker,
        body_parts: [],
        body: null,
        code_lines: [],
        code: [],
        code_parts: [],
        bullets: [],
        _bullet_sizes: BULLET_FONT_TIERS[0],
      },
    ];
  }

  const pages: Array<Record<string, unknown>> = [];
  let body_cursor = 0;
  let code_cursor = 0;
  let bullet_cursor = 0;

  while (
    body_cursor < body_parts.length ||
    code_cursor < code_lines.length ||
    bullet_cursor < bullets.length
  ) {
    let used_height = 0.0;
    const page_body: string[] = [];
    const page_code: string[] = [];
    const page_bullets: Array<Record<string, unknown>> = [];
    let bullet_sizes: readonly [number, number, number] | number[] = BULLET_FONT_TIERS[0];
    let active_class_blocked = false;

    while (body_cursor < body_parts.length) {
      const paragraph = String(body_parts[body_cursor]);
      const paragraph_height = _body_paragraph_height(
        paragraph,
        line_break_mode,
        body_font_path,
        mono_font_path,
        content_width
      );
      if (paragraph_height > content_height) {
        throw new ValueError("single paragraph exceeds content area");
      }
      if (used_height + paragraph_height > content_height) {
        active_class_blocked = true;
        break;
      }
      page_body.push(paragraph);
      used_height += paragraph_height;
      body_cursor += 1;
    }

    if (!active_class_blocked) {
      while (code_cursor < code_lines.length) {
        const line = code_lines[code_cursor] ?? "";
        const line_height = _code_source_line_height(line, mono_font_path);
        const panel_padding = page_code.length === 0 ? CODE_PANEL_PADDING_IN : 0.0;
        if (line_height + CODE_PANEL_PADDING_IN > content_height) {
          throw new ValueError("single code line exceeds content area");
        }
        if (used_height + panel_padding + line_height > content_height) {
          active_class_blocked = true;
          break;
        }
        page_code.push(line);
        used_height += panel_padding + line_height;
        code_cursor += 1;
      }
    }

    if (!active_class_blocked && bullet_cursor < bullets.length) {
      const first_bullet = _defined_at(bullets, bullet_cursor, "bullet item");
      const fitting_tiers = BULLET_FONT_TIERS.filter(
        (sizes) =>
          _bullet_height(
            first_bullet,
            sizes,
            line_break_mode,
            body_font_path,
            mono_font_path,
            content_width * 0.95
          ) <=
          content_height - used_height
      );
      if (fitting_tiers.length === 0) {
        const fits_clean_page = BULLET_FONT_TIERS.some(
          (sizes) =>
            _bullet_height(
              first_bullet,
              sizes,
              line_break_mode,
              body_font_path,
              mono_font_path,
              content_width * 0.95
            ) <= content_height
        );
        if (fits_clean_page && (page_body.length > 0 || page_code.length > 0)) {
          active_class_blocked = true;
        } else {
          throw new ValueError("single bullet item exceeds content area");
        }
      } else {
        bullet_sizes = _defined_at(fitting_tiers, 0, "bullet size tier");
      }
    }

    if (!active_class_blocked) {
      while (bullet_cursor < bullets.length) {
        const bullet = _defined_at(bullets, bullet_cursor, "bullet item");
        const item_height = _bullet_height(
          bullet,
          bullet_sizes,
          line_break_mode,
          body_font_path,
          mono_font_path,
          content_width * 0.95
        );
        if (used_height + item_height > content_height) break;
        page_bullets.push(bullet);
        used_height += item_height;
        bullet_cursor += 1;
      }
    }

    if (page_body.length === 0 && page_code.length === 0 && page_bullets.length === 0) {
      throw new ValueError("content cannot be placed without violating readability limits");
    }

    const page_index = pages.length;
    const page_title = page_index === 0 ? title : title ? `${title} (cont.)` : null;
    pages.push({
      layout: output_layout,
      title: page_title,
      kicker,
      body_parts: page_body,
      body: page_body.length > 0 ? page_body.join("\n\n") : null,
      code_lines: page_code,
      code: page_code.length > 0 ? [page_code.join("\n")] : [],
      code_parts: page_code.length > 0 ? [page_code.join("\n")] : [],
      bullets: page_bullets,
      _bullet_sizes: bullet_sizes,
    });
  }
  return pages;
}

export function _paginate_table(
  title: string | null,
  kicker: string | null,
  body_parts: string[],
  table: Record<string, unknown>,
  line_break_mode: Options["line_break_mode"],
  body_font_path: FontMetricSource,
  mono_font_path: FontMetricSource
): Array<Record<string, unknown>> {
  const headers = Array.isArray(table.headers) ? table.headers.map(String) : [];
  const rows = Array.isArray(table.rows)
    ? (table.rows as unknown[]).map((row) => (Array.isArray(row) ? row.map(String) : []))
    : [];
  const column_count = Math.max(1, headers.length, ...rows.map((row) => row.length));
  const column_width = CONTENT_W / column_count;
  const header_height = _table_row_height(
    headers,
    column_width,
    line_break_mode,
    body_font_path,
    mono_font_path,
    TABLE_HEADER_FONT_PT,
    TABLE_HEADER_MIN_HEIGHT_IN,
    true
  );
  if (header_height > CONTENT_HEIGHT) {
    throw new ValueError("table header exceeds available table area");
  }

  let intro_parts = [...body_parts];
  let intro_height = intro_parts.reduce(
    (sum, part) =>
      sum + _body_paragraph_height(part, line_break_mode, body_font_path, mono_font_path),
    0
  );
  const first_row_height =
    rows.length > 0
      ? _table_row_height(
          _defined_at(rows, 0, "table row"),
          column_width,
          line_break_mode,
          body_font_path,
          mono_font_path
        )
      : 0.0;
  let intro_pages: Array<Record<string, unknown>> = [];
  if (intro_parts.length > 0 && intro_height + header_height + first_row_height > CONTENT_HEIGHT) {
    intro_pages = _paginate_content(
      title,
      kicker,
      intro_parts,
      [],
      [],
      line_break_mode,
      body_font_path,
      mono_font_path
    );
    intro_parts = [];
    intro_height = 0.0;
  }

  if (rows.length === 0) {
    const global_index = intro_pages.length;
    const page_title = global_index === 0 ? title : title ? `${title} (cont.)` : null;
    return [
      ...intro_pages,
      {
        layout: "table",
        title: page_title,
        kicker,
        body_parts: intro_parts,
        body: intro_parts.length > 0 ? intro_parts.join("\n\n") : null,
        table: { headers, rows: [], header_height, row_heights: [] },
      },
    ];
  }

  const pages: Array<Record<string, unknown>> = [...intro_pages];
  let row_cursor = 0;
  let table_page_index = 0;
  while (row_cursor < rows.length) {
    let available_height = CONTENT_HEIGHT - header_height;
    if (table_page_index === 0) available_height -= intro_height;
    const chunk: string[][] = [];
    const row_heights: number[] = [];
    let used_height = 0.0;

    while (row_cursor < rows.length) {
      const row = _defined_at(rows, row_cursor, "table row");
      const row_height = _table_row_height(
        row,
        column_width,
        line_break_mode,
        body_font_path,
        mono_font_path
      );
      if (row_height > CONTENT_HEIGHT - header_height) {
        throw new ValueError("single table row exceeds available table area");
      }
      if (used_height + row_height > available_height) break;
      chunk.push(row);
      row_heights.push(row_height);
      used_height += row_height;
      row_cursor += 1;
    }

    if (chunk.length === 0) {
      throw new ValueError("single table row exceeds available table area");
    }
    const global_index = pages.length;
    const page_title = global_index === 0 ? title : title ? `${title} (cont.)` : null;
    pages.push({
      layout: "table",
      title: page_title,
      kicker,
      body_parts: table_page_index === 0 ? intro_parts : [],
      body: table_page_index === 0 && intro_parts.length > 0 ? intro_parts.join("\n\n") : null,
      table: { headers, rows: chunk, header_height, row_heights },
    });
    table_page_index += 1;
  }
  return pages;
}

function _create_text_objects(
  text: string,
  options: {
    font: string;
    size_pt: number;
    color: string;
    mono_font: string;
    line_break_mode: Options["line_break_mode"];
    bold?: boolean;
    italic?: boolean;
    link_color?: string;
    paragraph_options?: Partial<PptxTextRunOptions>;
    bullet?: PptxTextRunOptions["bullet"];
    indentLevel?: number;
  }
): PptxRichText {
  const tokens = _markdown_tokens(_MD_INLINE, text, true, "inline markdown parser output");
  const first = tokens[0];
  const children = first ? _token_children(first, "inline markdown root token") : [];
  const objects: PptxRichText = [];
  const state = {
    bold: Boolean(options.bold),
    italic: Boolean(options.italic),
    strike: false,
    href: null as string | null,
    pending_soft_break: false,
  };

  function flush(text_value: string, code = false): void {
    if (text_value.length === 0) return;
    const object_options: PptxTextRunOptions = {
      fontFace: code ? options.mono_font : options.font,
      fontSize: options.size_pt,
      color: state.href ? (options.link_color ?? options.color) : options.color,
      bold: state.bold,
      italic: state.italic,
    };
    if (state.strike) object_options.strike = "sngStrike";
    if (state.href) object_options.hyperlink = { url: state.href };
    if (state.pending_soft_break) {
      object_options.softBreakBefore = true;
      state.pending_soft_break = false;
    }
    if (options.bullet !== undefined) object_options.bullet = options.bullet;
    if (options.indentLevel !== undefined) object_options.indentLevel = options.indentLevel;
    if (options.paragraph_options) Object.assign(object_options, options.paragraph_options);
    objects.push({ text: text_value, options: object_options });
  }

  for (const token of children) {
    if (token.type === "strong_open") {
      state.bold = true;
      continue;
    }
    if (token.type === "strong_close") {
      state.bold = Boolean(options.bold);
      continue;
    }
    if (token.type === "em_open") {
      state.italic = true;
      continue;
    }
    if (token.type === "em_close") {
      state.italic = Boolean(options.italic);
      continue;
    }
    if (token.type === "s_open") {
      state.strike = true;
      continue;
    }
    if (token.type === "s_close") {
      state.strike = false;
      continue;
    }
    if (token.type === "link_open") {
      state.href = _child_href(token);
      continue;
    }
    if (token.type === "link_close") {
      state.href = null;
      continue;
    }
    if (token.type === "softbreak") {
      if (options.line_break_mode === "preserve") state.pending_soft_break = true;
      else flush(" ");
      continue;
    }
    if (token.type === "hardbreak") {
      state.pending_soft_break = true;
      continue;
    }
    if (token.type === "html_inline") {
      if (_validate_inline_html(token.content)) state.pending_soft_break = true;
      continue;
    }
    if (token.type === "image") {
      throw new ValueError("inline image mixed with text is not supported");
    }
    if (token.type === "code_inline") {
      flush(token.content, true);
      continue;
    }
    if (token.type === "text") {
      flush(token.content, false);
    }
  }
  return objects;
}

function _append_breakline(objects: PptxRichText): PptxRichText {
  if (objects.length === 0) return [{ text: "", options: { breakLine: true } }];
  const last = _defined_at(objects, objects.length - 1, "text run");
  last.options = { ...(last.options ?? {}), breakLine: true };
  return objects;
}

function _paragraph_objects(
  text: string,
  options: {
    font: string;
    size_pt: number;
    color: string;
    mono_font: string;
    line_break_mode: Options["line_break_mode"];
    bold?: boolean;
    italic?: boolean;
    link_color?: string;
    paragraph_options?: Partial<PptxTextRunOptions>;
  },
  break_after: boolean
): PptxRichText {
  const objects = _create_text_objects(text, options);
  return break_after ? _append_breakline(objects) : objects;
}

async function _crop_asset_to_frame(
  media: MediaSpec,
  width_in: number,
  height_in: number
): Promise<Buffer> {
  const asset = media.asset;
  if (!asset) throw new ValueError("cropped asset is not available");
  const frame_ratio = width_in / height_in;
  const image_ratio = asset.width_px / asset.height_px;
  let left = 0;
  let top = 0;
  let crop_width = asset.width_px;
  let crop_height = asset.height_px;
  if (image_ratio > frame_ratio) {
    crop_width = Math.round(asset.height_px * frame_ratio);
    const max_left = asset.width_px - crop_width;
    left = Math.round(
      Math.min(Math.max(asset.width_px * media.focal_point.x - crop_width / 2, 0), max_left)
    );
  } else {
    crop_height = Math.round(asset.width_px / frame_ratio);
    const max_top = asset.height_px - crop_height;
    top = Math.round(
      Math.min(Math.max(asset.height_px * media.focal_point.y - crop_height / 2, 0), max_top)
    );
  }
  const pipeline = sharp(asset.payload).extract({
    left,
    top,
    width: crop_width,
    height: crop_height,
  });
  if (asset.image_format === "JPEG") {
    return await pipeline.jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
  }
  return await pipeline.png().toBuffer();
}

async function _legacy_prepared_image(
  source_path: string,
  _project_root: string
): Promise<{ payload: Buffer; width_px: number; height_px: number; image_format: "PNG" | "JPEG" }> {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(source_path);
  } catch {
    throw new ValueError(`corrupt image: ${source_path}`);
  }
  try {
    const metadata = await sharp(buffer, { animated: false, limitInputPixels: false }).metadata();
    const width_px = metadata.width ?? 0;
    const height_px = metadata.height ?? 0;
    if (width_px <= 0 || height_px <= 0) throw new Error("invalid dimensions");
    const format = String(metadata.format ?? "").toUpperCase();
    let payload: Buffer;
    if (format === "JPEG" || format === "JPG") {
      payload = await sharp(buffer)
        .rotate()
        .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
        .toBuffer();
      return { payload, width_px, height_px, image_format: "JPEG" };
    }
    payload = await sharp(buffer).rotate().png().toBuffer();
    return { payload, width_px, height_px, image_format: "PNG" };
  } catch {
    throw new ValueError(`corrupt image: ${source_path}`);
  }
}

function to_data_uri(payload: Buffer, image_format: "PNG" | "JPEG"): string {
  return `data:image/${image_format === "PNG" ? "png" : "jpeg"};base64,${payload.toString("base64")}`;
}

export class PptxBuilder {
  opts: Options;
  theme: Theme;
  prs: PptxPresentation;
  warnings: string[] = [];
  layouts_used: Record<string, number> = {};
  section_index = 0;
  resolved_design_slides: Array<Record<string, unknown>> = [];
  deck_default_design: ResolvedDesign;
  font_paths: Record<string, FontMetricSource>;
  _current_design: ResolvedDesign | null = null;
  _current_layout: string | null = null;

  constructor(opts: Options) {
    this.opts = opts;
    this.theme = opts.theme;
    this.deck_default_design = _resolve_design(opts, {
      layout: "content",
      _design_patch: {
        palette: {},
        background_is_set: false,
        background: null,
        mark_is_set: false,
        mark: null,
        supplied: false,
      } satisfies SlideDesignPatch,
    });
    this.prs = createPptxPresentation(pptxgen);
    this.prs.defineLayout({ name: "PENNY_WIDE", width: SLIDE_W, height: SLIDE_H });
    this.prs.layout = "PENNY_WIDE";
    this.prs.theme = {
      headFontFace: this.theme.heading_font,
      bodyFontFace: this.theme.body_font,
    };
    this.prs.title = opts.title ?? "Penny Presentation";
    this.prs.author = opts.author ?? "Penny";
    this.prs.subject = "Penny Presentation";
    this.font_paths = Object.fromEntries(
      opts.font_plan.map((choice) => [
        choice.role,
        {
          regular: choice.metrics_path ? [choice.metrics_path, choice.metrics_face_index] : null,
          styles: { ...(choice.metrics_styles ?? {}) },
        } satisfies FontMetricPlan,
      ])
    );
    for (const choice of opts.font_plan) {
      if (choice.substituted) {
        this.warnings.push(
          `font '${choice.requested}' unavailable for role='${choice.role}', used '${choice.resolved}'`
        );
      } else if (!choice.verified) {
        this.warnings.push(
          `font availability could not be verified for role='${choice.role}': '${choice.requested}'`
        );
      }
    }
  }

  get palette(): Palette {
    return this._current_design?.palette ?? this.opts.palette;
  }

  get design_active(): boolean {
    return Boolean(this._current_design?.active);
  }

  _metrics_path_for_font(font: string): FontMetricSource {
    if (font === this.theme.heading_font) return this.font_paths.heading ?? null;
    if (font === this.theme.mono_font) return this.font_paths.mono ?? null;
    return this.font_paths.body ?? null;
  }

  _new_slide(layout: string): PptxSlide {
    this.layouts_used[layout] = (this.layouts_used[layout] ?? 0) + 1;
    const slide = adaptPptxSlide(this.prs.addSlide());
    if (this.design_active) {
      this._rect(slide, 0, 0, SLIDE_W, SLIDE_H, this.palette.background, "Penny Canvas");
    }
    return slide;
  }

  _rect(
    slide: PptxSlide,
    x: number,
    y: number,
    w: number,
    h: number,
    color: string,
    name?: string
  ): void {
    slide.addShape("rect", {
      x,
      y,
      w,
      h,
      fill: { color },
      line: { type: "none" },
      objectName: name,
    });
  }

  _add_overlay(
    slide: PptxSlide,
    frame: [number, number, number, number],
    overlay: Overlay | null,
    name: string
  ): void {
    if (!overlay) return;
    const [x, y, width, height] = frame;
    slide.addShape("rect", {
      x,
      y,
      w: width,
      h: height,
      fill: {
        color: overlay.color,
        transparency: Math.max(0, Math.min(100, 100 - overlay.opacity * 100)),
      },
      line: { type: "none" },
      objectName: name,
    });
  }

  _assert_text_fits(
    text: string,
    width_in: number,
    height_in: number,
    font_pt: number,
    font: string,
    label: string,
    bold = false,
    italic = false
  ): void {
    const lines = _estimate_lines(
      text,
      width_in,
      font_pt,
      this.opts.line_break_mode,
      this._metrics_path_for_font(font),
      this.font_paths.mono ?? null,
      bold,
      italic
    );
    const estimated_height = (lines * font_pt * 1.15) / POINTS_PER_INCH;
    if (estimated_height > height_in) {
      throw new ValueError(`${label} text does not fit its fixed layout box`);
    }
  }

  _text(
    slide: PptxSlide,
    x: number,
    y: number,
    w: number,
    h: number,
    text: string,
    font: string,
    size_pt: number,
    color: string,
    options: {
      bold?: boolean;
      italic?: boolean;
      align?: "left" | "center" | "right";
      valign?: "top" | "middle" | "bottom";
      link_color?: string;
      name?: string;
    } = {}
  ): void {
    this._assert_text_fits(
      text,
      w,
      h,
      size_pt,
      font,
      "slide",
      Boolean(options.bold),
      Boolean(options.italic)
    );
    slide.addText(
      _create_text_objects(text, {
        font,
        size_pt,
        color,
        mono_font: this.theme.mono_font,
        line_break_mode: this.opts.line_break_mode,
        bold: options.bold,
        italic: options.italic,
        link_color: options.link_color ?? this.palette.link,
      }),
      {
        x,
        y,
        w,
        h,
        fontFace: font,
        fontSize: size_pt,
        color,
        isTextBox: true,
        margin: 0,
        valign: options.valign ?? "top",
        align: options.align ?? "left",
        objectName: options.name,
        fit: "none",
      }
    );
  }

  async _add_media_picture(
    slide: PptxSlide,
    media: MediaSpec,
    x: number,
    y: number,
    width: number,
    height: number,
    name: string,
    warning_label: string
  ): Promise<[number, number, number, number]> {
    const asset = media.asset;
    if (!asset) throw new ValueError(`${warning_label} asset was not preflighted`);
    const image_ratio = asset.width_px / asset.height_px;
    const frame_ratio = width / height;
    if (media.fit === "contain") {
      const rendered_width = Math.min(width, height * image_ratio);
      const rendered_height = rendered_width / image_ratio;
      const left = x + (width - rendered_width) / 2;
      const top = y + (height - rendered_height) / 2;
      slide.addImage({
        data: to_data_uri(asset.payload, asset.image_format),
        x: left,
        y: top,
        w: rendered_width,
        h: rendered_height,
        objectName: name,
      });
      const ppi_x = asset.width_px / rendered_width;
      const ppi_y = asset.height_px / rendered_height;
      if (ppi_x < MIN_EFFECTIVE_PPI) {
        this.warnings.push(
          `low effective horizontal PPI for ${warning_label}: ${ppi_x.toFixed(1)}`
        );
      }
      if (ppi_y < MIN_EFFECTIVE_PPI) {
        this.warnings.push(`low effective vertical PPI for ${warning_label}: ${ppi_y.toFixed(1)}`);
      }
      return [left, top, rendered_width, rendered_height];
    }
    const visible_width_fraction = image_ratio > frame_ratio ? frame_ratio / image_ratio : 1.0;
    const visible_height_fraction = image_ratio > frame_ratio ? 1.0 : image_ratio / frame_ratio;
    const cropped = await _crop_asset_to_frame(media, width, height);
    slide.addImage({
      data: to_data_uri(cropped, asset.image_format),
      x,
      y,
      w: width,
      h: height,
      objectName: name,
    });
    const ppi_x = (asset.width_px * visible_width_fraction) / width;
    const ppi_y = (asset.height_px * visible_height_fraction) / height;
    if (ppi_x < MIN_EFFECTIVE_PPI) {
      this.warnings.push(`low effective horizontal PPI for ${warning_label}: ${ppi_x.toFixed(1)}`);
    }
    if (ppi_y < MIN_EFFECTIVE_PPI) {
      this.warnings.push(`low effective vertical PPI for ${warning_label}: ${ppi_y.toFixed(1)}`);
    }
    return [x, y, width, height];
  }

  async _add_mark(slide: PptxSlide): Promise<void> {
    if (!this.design_active || !this._current_design?.mark) return;
    const mark = this._current_design.mark;
    const media: MediaSpec = {
      path: mark.path,
      fit: mark.fit,
      focal_point: mark.focal_point,
      overlay: null,
      asset: mark.asset,
    };
    await this._add_media_picture(
      slide,
      media,
      mark.x * SLIDE_W,
      mark.y * SLIDE_H,
      mark.width * SLIDE_W,
      mark.height * SLIDE_H,
      "Penny Mark",
      "mark"
    );
  }

  async _add_standard_design_layers(
    slide: PptxSlide,
    layout: string,
    spec: Record<string, unknown>
  ): Promise<void> {
    if (!this.design_active) return;
    if (layout === "title") {
      this._rect(slide, 0.42, 2.15, 12.49, 4.85, this.palette.surface, "Penny Title Surface");
    } else if (["content", "two_column", "table", "quote"].includes(layout)) {
      this._rect(slide, 0.42, 0.32, 12.49, 7.06, this.palette.surface, "Penny Content Surface");
    } else if (layout === "image") {
      if (spec.title || spec.kicker) {
        this._rect(
          slide,
          0.42,
          0.32,
          12.49,
          1.48,
          this.palette.surface,
          "Penny Image Header Surface"
        );
      }
      if (spec.caption) {
        this._rect(slide, 0.42, 6.45, 12.49, 0.52, this.palette.surface, "Penny Caption Surface");
      }
      if (spec._image_missing) {
        this._rect(
          slide,
          0.42,
          3.05,
          12.49,
          0.9,
          this.palette.surface,
          "Penny Image Placeholder Surface"
        );
      }
      this._rect(slide, 0.42, 7.02, 12.49, 0.36, this.palette.surface, "Penny Footer Surface");
    }
    await this._add_mark(slide);
  }

  _footer(slide: PptxSlide, number: number): void {
    let footer_x = MARGIN;
    let footer_width = 6.0;
    let number_x = SLIDE_W - MARGIN - 0.6;
    if (this._current_layout === "image_left") {
      footer_x = COMPOSED_MEDIA_W + 0.6;
      footer_width = 4.5;
    } else if (this._current_layout === "image_right") {
      footer_width = 4.5;
      number_x = SLIDE_W - COMPOSED_MEDIA_W - 1.2;
    }
    if (this.opts.footer_text) {
      this._text(
        slide,
        footer_x,
        7.08,
        footer_width,
        0.3,
        this.opts.footer_text,
        this.theme.body_font,
        10,
        this.palette.text_muted,
        { name: "Penny Footer" }
      );
    }
    if (this.opts.slide_numbers) {
      this._text(
        slide,
        number_x,
        7.08,
        0.6,
        0.3,
        String(number),
        this.theme.body_font,
        10,
        this.palette.text_muted,
        { align: "right", name: "Penny Slide Number" }
      );
    }
  }

  _content_header(slide: PptxSlide, title: string | null, kicker: string | null): void {
    if (kicker) {
      this._text(
        slide,
        MARGIN,
        0.52,
        CONTENT_W,
        0.32,
        kicker.toUpperCase(),
        this.theme.body_font,
        11,
        this.palette.accent_text,
        { bold: true }
      );
    }
    if (title) {
      this._text(
        slide,
        MARGIN,
        0.85,
        CONTENT_W,
        0.75,
        title,
        this.theme.heading_font,
        24,
        this.palette.text,
        { bold: true }
      );
      this._rect(slide, MARGIN, 1.68, 1.1, 0.045, this.palette.accent);
    }
  }

  _body_text(
    slide: PptxSlide,
    y: number,
    body_parts: string[],
    options: {
      x?: number;
      width?: number;
      font_pt?: number;
      line_height_in?: number;
      bottom?: number;
      color?: string;
    } = {}
  ): number {
    const x = options.x ?? MARGIN;
    const width = options.width ?? CONTENT_W;
    const font_pt = options.font_pt ?? BODY_FONT_PT;
    const line_height_in = options.line_height_in ?? BODY_LINE_HEIGHT_IN;
    const bottom = options.bottom ?? CONTENT_BOTTOM;
    const color = options.color ?? this.palette.text;
    const height = body_parts.reduce(
      (sum, part) =>
        sum +
        _body_paragraph_height(
          part,
          this.opts.line_break_mode,
          this.font_paths.body ?? null,
          this.font_paths.mono ?? null,
          width,
          font_pt,
          line_height_in
        ),
      0
    );
    if (y + height > bottom + 1e-6) {
      throw new ValueError("body content overflows the planned content area");
    }
    const objects = body_parts.flatMap((part, index) =>
      _paragraph_objects(
        part,
        {
          font: this.theme.body_font,
          size_pt: font_pt,
          color,
          mono_font: this.theme.mono_font,
          line_break_mode: this.opts.line_break_mode,
          link_color: this.palette.link,
          paragraph_options: {
            lineSpacing: line_height_in * POINTS_PER_INCH,
            paraSpaceAfter: PARAGRAPH_GAP_IN * POINTS_PER_INCH,
          },
        },
        index < body_parts.length - 1
      )
    );
    slide.addText(objects, {
      x,
      y,
      w: width,
      h: height,
      fontFace: this.theme.body_font,
      fontSize: font_pt,
      color,
      isTextBox: true,
      margin: 0,
      valign: "top",
      align: "left",
      fit: "none",
    });
    return y + height;
  }

  _code_panel(slide: PptxSlide, y: number, code_lines: string[]): number {
    const content_height = code_lines.reduce(
      (sum, line) => sum + _code_source_line_height(line, this.font_paths.mono ?? null),
      0
    );
    const height = content_height + CODE_PANEL_PADDING_IN;
    if (y + height > CONTENT_BOTTOM + 1e-6) {
      throw new ValueError("code content overflows the planned content area");
    }
    this._rect(slide, MARGIN, y, CONTENT_W, height, this.palette.code_background);
    const objects = code_lines.flatMap((line, index) => {
      const object_options: PptxTextRunOptions = {
        fontFace: this.theme.mono_font,
        fontSize: CODE_FONT_PT,
        color: this.palette.code_text,
        breakLine: index < code_lines.length - 1,
        lineSpacing: CODE_LINE_HEIGHT_IN * POINTS_PER_INCH,
        paraSpaceAfter: 0,
        paraSpaceBefore: 0,
      };
      return [{ text: line || " ", options: object_options }];
    });
    slide.addText(objects, {
      x: MARGIN + 0.15,
      y: y + CODE_PANEL_PADDING_IN / 2,
      w: CONTENT_W - 0.3,
      h: content_height,
      fontFace: this.theme.mono_font,
      fontSize: CODE_FONT_PT,
      color: this.palette.code_text,
      margin: 0,
      isTextBox: true,
      valign: "top",
      fit: "none",
      objectName: "Penny Code",
    });
    return y + height;
  }

  _bullets_into(
    slide: PptxSlide,
    x: number,
    y: number,
    width: number,
    height: number,
    bullets: Array<Record<string, unknown>>,
    sizes: readonly [number, number, number] | number[]
  ): void {
    const glyphs = ["2022", "2013", "00B7"];
    const bottom = y + height + 1e-6;
    let cursor = y;
    for (const bullet of bullets) {
      const level = Math.max(0, Math.min(2, Number(bullet.level ?? 0)));
      const size = Number(sizes[level]);
      const item_height = _bullet_height(
        bullet,
        sizes,
        this.opts.line_break_mode,
        this.font_paths.body ?? null,
        this.font_paths.mono ?? null,
        width
      );
      if (cursor + item_height > bottom) {
        throw new ValueError("bullet content overflows the planned content area");
      }
      slide.addText(
        _create_text_objects(String(bullet.text ?? ""), {
          font: this.theme.body_font,
          size_pt: size,
          color: level === 0 ? this.palette.text : this.palette.text_muted,
          mono_font: this.theme.mono_font,
          line_break_mode: this.opts.line_break_mode,
          bold: Boolean(bullet.bold),
          link_color: this.palette.link,
        }),
        {
          x,
          y: cursor,
          w: width,
          h: item_height,
          fontFace: this.theme.body_font,
          fontSize: size,
          color: level === 0 ? this.palette.text : this.palette.text_muted,
          margin: 0,
          isTextBox: true,
          valign: "top",
          fit: "none",
          bullet: { code: glyphs[level] },
          indentLevel: level,
          lineSpacing: size * BULLET_LINE_HEIGHT_FACTOR,
          paraSpaceAfter: Math.max(4.0, size * BULLET_GAP_FACTOR),
        }
      );
      cursor += item_height;
    }
  }

  _notes(slide: PptxSlide, notes: string | null): void {
    if (notes) slide.addNotes(notes);
  }

  _composed_geometry(layout: string): Record<string, [number, number, number, number]> {
    if (layout === "image_left") {
      const pane_x = COMPOSED_MEDIA_W;
      const pane_width = SLIDE_W - COMPOSED_MEDIA_W;
      return {
        media: [0.0, 0.0, COMPOSED_MEDIA_W, SLIDE_H],
        panel: [pane_x, 0.0, pane_width, SLIDE_H],
        title: [pane_x + 0.6, 0.78, pane_width - 1.2, 0.92],
        content: [pane_x + 0.6, 1.92, pane_width - 1.2, 4.95],
      };
    }
    if (layout === "image_right") {
      const pane_width = SLIDE_W - COMPOSED_MEDIA_W;
      return {
        media: [pane_width, 0.0, COMPOSED_MEDIA_W, SLIDE_H],
        panel: [0.0, 0.0, pane_width, SLIDE_H],
        title: [0.6, 0.78, pane_width - 1.2, 0.92],
        content: [0.6, 1.92, pane_width - 1.2, 4.95],
      };
    }
    const [panel_x, panel_y, panel_width, panel_height] = FULL_BLEED_PANEL;
    return {
      media: [0.0, 0.0, SLIDE_W, SLIDE_H],
      panel: FULL_BLEED_PANEL,
      title: [panel_x + 0.45, panel_y + 0.38, panel_width - 0.9, 0.9],
      content: [panel_x + 0.45, panel_y + 1.52, panel_width - 0.9, panel_height - 1.87],
    };
  }

  _carry_page_metadata(
    spec: Record<string, unknown>,
    pages: Array<Record<string, unknown>>
  ): Array<Record<string, unknown>> {
    const design_patch = _slide_design_patch(spec, "source slide");
    const media = _media_spec_or_null(spec, "_media", "source slide");
    pages.forEach((page, index) => {
      page._origin_index = spec._origin_index ?? 0;
      page._source_layout = spec._source_layout ?? spec.layout;
      page._continuation_index = index;
      page._design_patch = design_patch;
      if (media) page._media = media;
      if (index === 0 && spec.caption !== undefined) page.caption = spec.caption;
    });
    return pages;
  }

  _content_pages_for_spec(spec: Record<string, unknown>): Array<Record<string, unknown>> {
    const body_parts =
      spec.body_parts === undefined
        ? spec.body
          ? [String(spec.body)]
          : []
        : _string_array(spec.body_parts, "slide.body_parts").filter((part) => part.length > 0);
    let code_parts: string[];
    if (spec.code_lines !== undefined) {
      code_parts = [
        _string_array(spec.code_lines, "slide.code_lines", { null_is_missing: true }).join("\n"),
      ];
    } else if (spec.code !== undefined && spec.code !== null) {
      code_parts = _string_array(spec.code, "slide.code");
    } else {
      code_parts = _string_array(spec.code_parts, "slide.code_parts", { null_is_missing: true });
    }
    const layout = String(spec.layout);
    let content_width = CONTENT_W;
    let content_height = CONTENT_HEIGHT;
    if (_is_composed_layout(layout)) {
      const geometry = this._composed_geometry(layout);
      content_width = geometry.content[2];
      content_height = geometry.content[3];
    }
    const pages = _paginate_content(
      spec.title ? String(spec.title) : null,
      spec.kicker ? String(spec.kicker) : null,
      body_parts,
      _optional_array(spec.bullets, "slide.bullets").map(_normalize_bullet),
      code_parts,
      this.opts.line_break_mode,
      this.font_paths.body ?? null,
      this.font_paths.mono ?? null,
      { output_layout: layout, content_width, content_height }
    );
    if (spec.notes && pages.length > 0) _defined_at(pages, 0, "content page").notes = spec.notes;
    return this._carry_page_metadata(spec, pages);
  }

  _table_pages_for_spec(spec: Record<string, unknown>): Array<Record<string, unknown>> {
    const table = _optional_record(spec.table, "slide.table");
    if (table._prepaginated) return [spec];
    let body_parts = _string_array(spec.body_parts, "slide.body_parts", {
      null_is_missing: true,
    });
    if (body_parts.length === 0 && spec.body) body_parts = _body_parts(spec.body);
    const pages = _paginate_table(
      spec.title ? String(spec.title) : null,
      spec.kicker ? String(spec.kicker) : null,
      body_parts,
      table,
      this.opts.line_break_mode,
      this.font_paths.body ?? null,
      this.font_paths.mono ?? null
    );
    if (spec.notes && pages.length > 0) _defined_at(pages, 0, "table page").notes = spec.notes;
    return this._carry_page_metadata(spec, pages);
  }

  _pages_from(spec: Record<string, unknown>): Array<Record<string, unknown>> {
    const layout = String(spec.layout);
    if (layout === "content" || _is_composed_layout(layout)) {
      return this._content_pages_for_spec(spec);
    }
    if (layout === "table") return this._table_pages_for_spec(spec);
    return this._carry_page_metadata(spec, [{ ...spec }]);
  }

  _builder_for_layout(layout: LayoutName): PptxSlideBuilder {
    switch (layout) {
      case "title":
        return this._build_title.bind(this);
      case "section":
        return this._build_section.bind(this);
      case "content":
        return this._build_content.bind(this);
      case "two_column":
        return this._build_two_column.bind(this);
      case "table":
        return this._build_table.bind(this);
      case "quote":
        return this._build_quote.bind(this);
      case "image":
        return this._build_image.bind(this);
      case "closing":
        return this._build_closing.bind(this);
      case "image_left":
        return this._build_image_left.bind(this);
      case "image_right":
        return this._build_image_right.bind(this);
      case "full_bleed":
        return this._build_full_bleed.bind(this);
    }
  }

  async build(spec: Record<string, unknown>, number: number): Promise<number> {
    const pages = this._pages_from(spec);
    for (const page of pages) {
      const layout = String(page.layout);
      if (!_is_layout(layout)) {
        throw new ValueError(`unsupported layout ${JSON.stringify(layout)}`);
      }
      this._current_layout = layout;
      this._current_design = _resolve_design(this.opts, page);
      const slide = await this._builder_for_layout(layout)(page);
      if (FOOTER_LAYOUTS.has(layout)) {
        this._footer(slide, number);
      }
      this._notes(slide, page.notes ? String(page.notes) : null);
      this.resolved_design_slides.push(_resolved_design_record(this._current_design, page, number));
      number += 1;
    }
    return pages.length;
  }

  async _build_title(spec: Record<string, unknown>): Promise<PptxSlide> {
    const slide = this._new_slide("title");
    await this._add_standard_design_layers(slide, "title", spec);
    this._rect(slide, MARGIN, 2.35, 1.6, 0.055, this.palette.accent);
    this._text(
      slide,
      MARGIN,
      2.55,
      11.0,
      1.7,
      spec.title ? String(spec.title) : "Presentation",
      this.theme.heading_font,
      40,
      this.palette.text,
      { bold: true }
    );
    const subtitle = spec.subtitle ? String(spec.subtitle) : this.opts.subtitle;
    if (subtitle)
      this._text(
        slide,
        MARGIN,
        4.2,
        10.5,
        0.9,
        subtitle,
        this.theme.body_font,
        18,
        this.palette.text_muted
      );
    const meta = [
      spec.author ? String(spec.author) : this.opts.author,
      spec.date ? String(spec.date) : this.opts.date,
    ]
      .filter(Boolean)
      .join("  ·  ");
    if (meta)
      this._text(
        slide,
        MARGIN,
        6.35,
        10.0,
        0.45,
        meta,
        this.theme.body_font,
        12,
        this.palette.text_muted
      );
    this._rect(slide, 11.6, 5.9, 1.05, 1.05, this.palette.accent_soft);
    this._rect(slide, 12.15, 6.45, 0.5, 0.5, this.palette.accent);
    return slide;
  }

  async _build_section(spec: Record<string, unknown>): Promise<PptxSlide> {
    const slide = this._new_slide("section");
    this.section_index += 1;
    this._rect(slide, 0, 0, SLIDE_W, SLIDE_H, this.palette.accent);
    await this._add_mark(slide);
    this._text(
      slide,
      10.4,
      0.45,
      2.4,
      1.7,
      String(this.section_index).padStart(2, "0"),
      this.theme.heading_font,
      96,
      this.design_active
        ? this.palette.on_accent
        : _mix(this.palette.accent, this.palette.on_accent, 0.25),
      { bold: true, align: "right", link_color: this.palette.link_on_accent }
    );
    this._rect(slide, MARGIN, 2.95, 1.2, 0.055, this.palette.on_accent);
    this._text(
      slide,
      MARGIN,
      3.15,
      11.9,
      1.6,
      spec.title ? String(spec.title) : "",
      this.theme.heading_font,
      32,
      this.palette.on_accent,
      { bold: true, link_color: this.palette.link_on_accent }
    );
    return slide;
  }

  async _build_content(spec: Record<string, unknown>): Promise<PptxSlide> {
    const slide = this._new_slide("content");
    await this._add_standard_design_layers(slide, "content", spec);
    this._content_header(
      slide,
      spec.title ? String(spec.title) : null,
      spec.kicker ? String(spec.kicker) : null
    );
    let y = CONTENT_TOP;
    const body_parts = _string_array(spec.body_parts, "content page body_parts");
    if (body_parts.length > 0) y = this._body_text(slide, y, body_parts);
    const code_lines = _string_array(spec.code_lines, "content page code_lines");
    if (code_lines.length > 0) y = this._code_panel(slide, y, code_lines);
    const bullets = _optional_array(spec.bullets, "content page bullets").map(_normalize_bullet);
    if (bullets.length > 0) {
      const sizes =
        spec._bullet_sizes === undefined
          ? [...BULLET_FONT_TIERS[0]]
          : _number_array(spec._bullet_sizes, "content page bullet sizes");
      const height = bullets.reduce(
        (sum, bullet) =>
          sum +
          _bullet_height(
            bullet,
            sizes,
            this.opts.line_break_mode,
            this.font_paths.body ?? null,
            this.font_paths.mono ?? null
          ),
        0
      );
      if (y + height > CONTENT_BOTTOM + 1e-6)
        throw new ValueError("bullet content overflows the planned content area");
      this._bullets_into(slide, MARGIN, y, CONTENT_W, Math.max(0.5, height), bullets, sizes);
    }
    return slide;
  }

  async _build_two_column(spec: Record<string, unknown>): Promise<PptxSlide> {
    const slide = this._new_slide("two_column");
    await this._add_standard_design_layers(slide, "two_column", spec);
    this._content_header(
      slide,
      spec.title ? String(spec.title) : null,
      spec.kicker ? String(spec.kicker) : null
    );
    const column_w = (CONTENT_W - 0.6) / 2;
    const body_font_pt = 13.0;
    const body_line_height = (body_font_pt * BULLET_LINE_HEIGHT_FACTOR) / POINTS_PER_INCH;
    for (const [index, side] of ["left", "right"].entries()) {
      const column = _optional_record(spec[side], `${side} column`);
      const x = MARGIN + index * (column_w + 0.6);
      let y = CONTENT_TOP;
      if (column.heading) {
        this._text(
          slide,
          x,
          y,
          column_w,
          0.4,
          String(column.heading),
          this.theme.body_font,
          15,
          this.palette.accent_text,
          { bold: true }
        );
        y += 0.5;
      }
      let column_body_parts = _string_array(column.body_parts, `${side} column body_parts`);
      if (column_body_parts.length === 0 && column.body)
        column_body_parts = _body_parts(column.body);
      if (column_body_parts.length > 0) {
        try {
          y = this._body_text(slide, y, column_body_parts, {
            x,
            width: column_w,
            font_pt: body_font_pt,
            line_height_in: body_line_height,
          });
        } catch {
          throw new ValueError(`${side} column content does not fit its fixed layout box`);
        }
      }
      const bullets = _optional_array(column.bullets, `${side} column bullets`).map(
        _normalize_bullet
      );
      if (bullets.length > 0) {
        const sizes = [...BULLET_FONT_TIERS[BULLET_FONT_TIERS.length - 1]];
        const bullet_height = bullets.reduce(
          (sum, bullet) =>
            sum +
            _bullet_height(
              bullet,
              sizes,
              this.opts.line_break_mode,
              this.font_paths.body ?? null,
              this.font_paths.mono ?? null,
              column_w
            ),
          0
        );
        if (y + bullet_height > CONTENT_BOTTOM + 1e-6)
          throw new ValueError(`${side} column content does not fit its fixed layout box`);
        this._bullets_into(slide, x, y, column_w, bullet_height, bullets, sizes);
      }
    }
    return slide;
  }

  async _build_table(spec: Record<string, unknown>): Promise<PptxSlide> {
    const slide = this._new_slide("table");
    await this._add_standard_design_layers(slide, "table", spec);
    this._content_header(
      slide,
      spec.title ? String(spec.title) : null,
      spec.kicker ? String(spec.kicker) : null
    );
    let y = CONTENT_TOP;
    let body_parts = Array.isArray(spec.body_parts)
      ? (spec.body_parts as unknown[]).map(String)
      : [];
    if (body_parts.length === 0 && spec.body) body_parts = _body_parts(spec.body);
    if (body_parts.length > 0) y = this._body_text(slide, y, body_parts);

    const table_spec = isRecord(spec.table) ? spec.table : {};
    const headers = Array.isArray(table_spec.headers) ? table_spec.headers.map(String) : [];
    const rows = Array.isArray(table_spec.rows)
      ? (table_spec.rows as unknown[]).map((row) => (Array.isArray(row) ? row.map(String) : []))
      : [];
    const cols = Math.max(headers.length, 1, ...rows.map((row) => row.length));
    const column_width = CONTENT_W / cols;
    const header_height = Number(
      table_spec.header_height ??
        _table_row_height(
          headers,
          column_width,
          this.opts.line_break_mode,
          this.font_paths.body ?? null,
          this.font_paths.mono ?? null,
          TABLE_HEADER_FONT_PT,
          TABLE_HEADER_MIN_HEIGHT_IN,
          true
        )
    );
    let row_heights = Array.isArray(table_spec.row_heights)
      ? (table_spec.row_heights as unknown[]).map(Number)
      : [];
    if (row_heights.length !== rows.length) {
      row_heights = rows.map((row) =>
        _table_row_height(
          row,
          column_width,
          this.opts.line_break_mode,
          this.font_paths.body ?? null,
          this.font_paths.mono ?? null
        )
      );
    }
    const table_height = header_height + row_heights.reduce((sum, height) => sum + height, 0);
    if (y + table_height > CONTENT_BOTTOM + 1e-6)
      throw new ValueError("table content overflows the planned content area");

    const table_rows: PptxTableRows = [];
    table_rows.push(
      headers.map((header) => ({
        text: _create_text_objects(header, {
          font: this.theme.body_font,
          size_pt: TABLE_HEADER_FONT_PT,
          color: this.palette.on_accent,
          mono_font: this.theme.mono_font,
          line_break_mode: this.opts.line_break_mode,
          bold: true,
          link_color: this.palette.link_on_accent,
        }),
        options: {
          fill: { color: this.palette.accent },
          color: this.palette.on_accent,
          bold: true,
          fontFace: this.theme.body_font,
          fontSize: TABLE_HEADER_FONT_PT,
          valign: "middle",
          margin: [
            TABLE_CELL_VERTICAL_PADDING_IN / 2,
            0.12,
            TABLE_CELL_VERTICAL_PADDING_IN / 2,
            0.12,
          ],
          border: { type: "solid", color: this.design_active ? this.palette.border : WHITE, pt: 1 },
        },
      }))
    );
    rows.forEach((row, row_index) => {
      const fill = this.design_active
        ? row_index % 2 === 1
          ? this.palette.surface_alt
          : this.palette.surface
        : row_index % 2 === 1
          ? BAND_FILL
          : WHITE;
      table_rows.push(
        Array.from({ length: cols }, (_, col_index) => {
          const value = row[col_index] ?? "";
          return {
            text: _create_text_objects(value, {
              font: this.theme.body_font,
              size_pt: TABLE_BODY_FONT_PT,
              color: this.palette.text,
              mono_font: this.theme.mono_font,
              line_break_mode: this.opts.line_break_mode,
              link_color: this.palette.link,
            }),
            options: {
              fill: { color: fill },
              color: this.palette.text,
              fontFace: this.theme.body_font,
              fontSize: TABLE_BODY_FONT_PT,
              valign: "middle",
              margin: [
                TABLE_CELL_VERTICAL_PADDING_IN / 2,
                0.12,
                TABLE_CELL_VERTICAL_PADDING_IN / 2,
                0.12,
              ],
              border: {
                type: "solid",
                color: this.design_active ? this.palette.border : WHITE,
                pt: 1,
              },
            },
          };
        })
      );
    });

    slide.addTable(table_rows, {
      x: MARGIN,
      y,
      w: CONTENT_W,
      h: table_height,
      colW: Array.from({ length: cols }, () => column_width),
      rowH: [header_height, ...row_heights],
      margin: [TABLE_CELL_VERTICAL_PADDING_IN / 2, 0.12, TABLE_CELL_VERTICAL_PADDING_IN / 2, 0.12],
      objectName: "Penny Table",
      border: { type: "solid", color: this.design_active ? this.palette.border : WHITE, pt: 1 },
      fontFace: this.theme.body_font,
      fontSize: TABLE_BODY_FONT_PT,
      color: this.palette.text,
      valign: "middle",
      autoPage: false,
    });
    return slide;
  }

  async _build_quote(spec: Record<string, unknown>): Promise<PptxSlide> {
    const slide = this._new_slide("quote");
    await this._add_standard_design_layers(slide, "quote", spec);
    const has_header = Boolean(spec.title || spec.kicker);
    if (has_header)
      this._content_header(
        slide,
        spec.title ? String(spec.title) : null,
        spec.kicker ? String(spec.kicker) : null
      );
    const [glyph_y, quote_y, attr_y] = has_header ? [1.85, 3.0, 5.6] : [0.55, 2.45, 5.35];
    this._text(
      slide,
      0.9,
      glyph_y,
      2.2,
      2.0,
      "“",
      this.theme.heading_font,
      120,
      this.palette.accent_soft,
      { bold: true }
    );
    this._text(
      slide,
      2.17,
      quote_y,
      9.0,
      2.4,
      spec.quote ? String(spec.quote) : "",
      this.theme.heading_font,
      24,
      this.palette.text,
      { italic: true, align: "center", valign: "middle" }
    );
    if (spec.attribution)
      this._text(
        slide,
        2.17,
        attr_y,
        9.0,
        0.5,
        `— ${String(spec.attribution)}`,
        this.theme.body_font,
        14,
        this.palette.text_muted,
        { align: "center" }
      );
    return slide;
  }

  async _build_composed(spec: Record<string, unknown>): Promise<PptxSlide> {
    const layout = String(spec.layout);
    if (!_is_composed_layout(layout)) {
      throw new ValueError(`unsupported composed layout ${JSON.stringify(layout)}`);
    }
    const slide = this._new_slide(layout);
    const geometry = this._composed_geometry(layout);
    const media = _media_spec_or_null(spec, "_media", `${layout} slide`);
    if (!media) throw new ValueError(`${layout} requires preflighted media`);
    const media_frame = await this._add_media_picture(
      slide,
      media,
      ...geometry.media,
      "Penny Media",
      "composed media"
    );
    this._add_overlay(slide, media_frame, media.overlay, "Penny Media Overlay");
    this._rect(
      slide,
      ...geometry.panel,
      this.palette.surface,
      layout === "full_bleed" ? "Penny Full Bleed Text Panel" : "Penny Text Pane"
    );
    if (layout === "full_bleed")
      this._rect(slide, 0.42, 7.02, 12.49, 0.36, this.palette.surface, "Penny Footer Surface");
    let caption_frame: [number, number, number, number] | null = null;
    if (spec.caption) {
      const [media_x, , media_width] = geometry.media;
      caption_frame =
        layout === "full_bleed"
          ? [7.2, 6.48, 5.4, 0.48]
          : [media_x + 0.2, 6.48, media_width - 0.4, 0.48];
      this._rect(slide, ...caption_frame, this.palette.surface, "Penny Media Caption Surface");
    }
    await this._add_mark(slide);

    const [title_x, title_y, title_width, title_height] = geometry.title;
    if (spec.kicker)
      this._text(
        slide,
        title_x,
        title_y - 0.34,
        title_width,
        0.26,
        String(spec.kicker).toUpperCase(),
        this.theme.body_font,
        11,
        this.palette.accent_text,
        { bold: true }
      );
    if (spec.title) {
      this._text(
        slide,
        title_x,
        title_y,
        title_width,
        title_height,
        String(spec.title),
        this.theme.heading_font,
        24,
        this.palette.heading,
        { bold: true }
      );
      this._rect(
        slide,
        title_x,
        title_y + title_height + 0.03,
        Math.min(1.1, title_width),
        0.045,
        this.palette.accent
      );
    }

    const [content_x, content_y, content_width, content_height] = geometry.content;
    let cursor = content_y;
    const body_parts = _string_array(spec.body_parts, `${layout} page body_parts`);
    if (body_parts.length > 0) {
      cursor = this._body_text(slide, cursor, body_parts, {
        x: content_x,
        width: content_width,
        bottom: content_y + content_height,
      });
    }
    const bullets = _optional_array(spec.bullets, `${layout} page bullets`).map(_normalize_bullet);
    if (bullets.length > 0) {
      const sizes =
        spec._bullet_sizes === undefined
          ? [...BULLET_FONT_TIERS[0]]
          : _number_array(spec._bullet_sizes, `${layout} page bullet sizes`);
      const bullet_height = bullets.reduce(
        (sum, bullet) =>
          sum +
          _bullet_height(
            bullet,
            sizes,
            this.opts.line_break_mode,
            this.font_paths.body ?? null,
            this.font_paths.mono ?? null,
            content_width * 0.95
          ),
        0
      );
      if (cursor + bullet_height > content_y + content_height + 1e-6)
        throw new ValueError("composed bullet content overflows its planned text frame");
      this._bullets_into(slide, content_x, cursor, content_width, bullet_height, bullets, sizes);
    }
    if (caption_frame) {
      const [caption_x, caption_y, caption_width, caption_height] = caption_frame;
      this._text(
        slide,
        caption_x + 0.1,
        caption_y + 0.08,
        caption_width - 0.2,
        caption_height - 0.12,
        String(spec.caption),
        this.theme.body_font,
        10,
        this.palette.text_muted,
        { align: "center" }
      );
    }
    return slide;
  }

  async _build_image_left(spec: Record<string, unknown>): Promise<PptxSlide> {
    return this._build_composed(spec);
  }
  async _build_image_right(spec: Record<string, unknown>): Promise<PptxSlide> {
    return this._build_composed(spec);
  }
  async _build_full_bleed(spec: Record<string, unknown>): Promise<PptxSlide> {
    return this._build_composed(spec);
  }

  async _build_image(spec: Record<string, unknown>): Promise<PptxSlide> {
    const slide = this._new_slide("image");
    if (!this.design_active)
      this._content_header(
        slide,
        spec.title ? String(spec.title) : null,
        spec.kicker ? String(spec.kicker) : null
      );
    const src = spec.image_path ? String(spec.image_path) : "";
    const resolved = path.isAbsolute(src) ? src : path.join(this.opts.project_root, src);
    const caption = spec.caption ? String(spec.caption) : null;
    const top = spec.title ? CONTENT_TOP : 0.9;
    const bottom = caption ? 6.45 : CONTENT_BOTTOM;

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      this.warnings.push(`image not found: ${src}`);
      if (this.design_active) {
        await this._add_standard_design_layers(slide, "image", { ...spec, _image_missing: true });
        this._content_header(
          slide,
          spec.title ? String(spec.title) : null,
          spec.kicker ? String(spec.kicker) : null
        );
      }
      this._text(
        slide,
        MARGIN,
        3.2,
        CONTENT_W,
        0.6,
        `[image unavailable: ${caption ?? src}]`,
        this.theme.body_font,
        14,
        this.palette.text_muted,
        { align: "center" }
      );
      return slide;
    }

    const prepared = await _legacy_prepared_image(resolved, this.opts.project_root);
    const ratio = prepared.width_px / prepared.height_px;
    const width_rendered = Math.min(CONTENT_W, (bottom - top) * ratio);
    const height_rendered = width_rendered / ratio;
    const ppi_x = prepared.width_px / width_rendered;
    const ppi_y = prepared.height_px / height_rendered;
    if (ppi_x < MIN_EFFECTIVE_PPI)
      this.warnings.push(`low effective horizontal PPI for image ${src}: ${ppi_x.toFixed(1)}`);
    if (ppi_y < MIN_EFFECTIVE_PPI)
      this.warnings.push(`low effective vertical PPI for image ${src}: ${ppi_y.toFixed(1)}`);

    slide.addImage({
      data: to_data_uri(prepared.payload, prepared.image_format),
      x: MARGIN + (CONTENT_W - width_rendered) / 2,
      y: top + (bottom - top - height_rendered) / 2,
      w: width_rendered,
      h: height_rendered,
      objectName: "Penny Legacy Image",
    });
    if (this.design_active) {
      await this._add_standard_design_layers(slide, "image", spec);
      this._content_header(
        slide,
        spec.title ? String(spec.title) : null,
        spec.kicker ? String(spec.kicker) : null
      );
    }
    if (caption)
      this._text(
        slide,
        MARGIN,
        6.55,
        CONTENT_W,
        0.4,
        caption,
        this.theme.body_font,
        11,
        this.palette.text_muted,
        { align: "center" }
      );
    return slide;
  }

  async _build_closing(spec: Record<string, unknown>): Promise<PptxSlide> {
    const slide = this._new_slide("closing");
    this._rect(slide, 0, 0, SLIDE_W, SLIDE_H, this.palette.accent);
    await this._add_mark(slide);
    this._text(
      slide,
      1.17,
      2.9,
      11.0,
      1.2,
      spec.title ? String(spec.title) : "Thank you",
      this.theme.heading_font,
      32,
      this.palette.on_accent,
      { bold: true, align: "center", link_color: this.palette.link_on_accent }
    );
    if (spec.subtitle)
      this._text(
        slide,
        1.17,
        4.15,
        11.0,
        0.8,
        String(spec.subtitle),
        this.theme.body_font,
        16,
        this.palette.on_accent,
        { align: "center", link_color: this.palette.link_on_accent }
      );
    return slide;
  }
}

function _load_slides(spec: Record<string, unknown>, opts: Options): [NormalizedSlide[], string[]] {
  const slides = spec.slides;
  const markdown = spec.markdown;
  const has_markdown = typeof markdown === "string" && markdown.trim().length > 0;
  if (slides && has_markdown) {
    throw new ValueError("provide exactly one of 'slides' or 'markdown', not both");
  }
  if (slides) {
    if (!Array.isArray(slides)) throw new ValueError("'slides' must be a non-empty array");
    return [slides.map((slide) => normalize_slide(slide)), []];
  }
  if (has_markdown) {
    const [result, warnings] = markdown_to_slides(String(markdown), opts);
    if (result.length === 0) throw new ValueError("markdown produced no slides");
    return [result, warnings];
  }
  throw new ValueError("spec requires 'slides' or non-empty 'markdown'");
}

type ParsedXmlNode = Record<string, unknown>;

function parsed_xml_node(value: unknown, label: string): ParsedXmlNode {
  if (!isRecord(value)) {
    throw new ValueError(`invalid generated PPTX package: ${label} must be an XML object`);
  }
  return value;
}

function parsed_xml_nodes(value: unknown, label: string): ParsedXmlNode[] {
  if (value === undefined) return [];
  if (isUnknownArray(value)) {
    return value.map((entry, index) => parsed_xml_node(entry, `${label}[${index}]`));
  }
  return [parsed_xml_node(value, label)];
}

function xml_attr(node: ParsedXmlNode, name: string): string | undefined {
  const value = node[`@_${name}`];
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function relationships_in_part(parsed: unknown, rels_part_name: string): ParsedXmlNode[] {
  if (!isRecord(parsed) || !isRecord(parsed.Relationships)) {
    throw new ValueError(
      `invalid generated PPTX package: malformed relationships part ${JSON.stringify(rels_part_name)}`
    );
  }
  const raw = parsed.Relationships.Relationship;
  if (raw === undefined) return [];
  try {
    return parsed_xml_nodes(raw, `relationships in ${JSON.stringify(rels_part_name)}`);
  } catch {
    throw new ValueError(
      `invalid generated PPTX package: malformed relationships part ${JSON.stringify(rels_part_name)}`
    );
  }
}

function source_part_for_relationships_part(rels_part_name: string): string | null {
  if (rels_part_name === "_rels/.rels") return null;
  const normalized = rels_part_name.replace(/\\/g, "/");
  const marker = "/_rels/";
  const marker_index = normalized.lastIndexOf(marker);
  if (marker_index < 0 || !normalized.endsWith(".rels")) {
    throw new ValueError(
      `invalid generated PPTX package: malformed relationships part ${JSON.stringify(rels_part_name)}`
    );
  }
  const source_directory = normalized.slice(0, marker_index);
  const rel_name = normalized.slice(marker_index + marker.length, -".rels".length);
  if (!rel_name) {
    throw new ValueError(
      `invalid generated PPTX package: malformed relationships part ${JSON.stringify(rels_part_name)}`
    );
  }
  return source_directory ? `${source_directory}/${rel_name}` : rel_name;
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
    `invalid generated PPTX package: unsupported TargetMode ${JSON.stringify(raw)} in ${relationship_label(rels_part_name, rel_id)}`
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
      `invalid generated PPTX package: missing external relationship type in ${relationship_label(rels_part_name, rel_id)}`
    );
  }
  if (relationship_type !== HYPERLINK_RELATIONSHIP_TYPE) {
    throw new ValueError(
      `invalid generated PPTX package: unsupported external relationship type ${JSON.stringify(relationship_type)} in ${relationship_label(rels_part_name, rel_id)}`
    );
  }
  if (!target) {
    throw new ValueError(
      `invalid generated PPTX package: empty external relationship target in ${relationship_label(rels_part_name, rel_id)}`
    );
  }
  let parsed_target: URL;
  try {
    parsed_target = new URL(target);
  } catch {
    throw new ValueError(
      `invalid generated PPTX package: invalid external relationship target ${JSON.stringify(target)} in ${relationship_label(rels_part_name, rel_id)}`
    );
  }
  const protocol = parsed_target.protocol.toLowerCase();
  if (!SAFE_EXTERNAL_HYPERLINK_PROTOCOLS.has(protocol)) {
    throw new ValueError(
      `invalid generated PPTX package: unsupported external hyperlink target scheme ${JSON.stringify(protocol)} in ${relationship_label(rels_part_name, rel_id)}`
    );
  }
}

function has_invalid_internal_relationship_target_characters(target: string): boolean {
  for (const character of target) {
    const code_point = character.codePointAt(0);
    if (code_point === undefined) continue;
    if (character === "\\" || code_point <= 0x1f || code_point === 0x7f) {
      return true;
    }
  }
  return false;
}

function resolve_internal_relationship_target(
  rels_part_name: string,
  source_part_name: string | null,
  target: string,
  rel_id: string | undefined
): string {
  if (!target) {
    throw new ValueError(
      `invalid generated PPTX package: empty internal relationship target in ${relationship_label(rels_part_name, rel_id)}`
    );
  }
  if (
    has_invalid_internal_relationship_target_characters(target) ||
    target.includes("?") ||
    target.includes("#")
  ) {
    throw new ValueError(
      `invalid generated PPTX package: invalid internal relationship target ${JSON.stringify(target)} in ${relationship_label(rels_part_name, rel_id)}`
    );
  }
  if (target.startsWith("//") || URI_SCHEME_RE.test(target)) {
    throw new ValueError(
      `invalid generated PPTX package: internal relationship target must stay inside the package in ${relationship_label(rels_part_name, rel_id)}`
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
          `invalid generated PPTX package: relationship target traversal escapes the package in ${relationship_label(rels_part_name, rel_id)}`
        );
      }
      resolved_segments.pop();
      continue;
    }
    resolved_segments.push(segment);
  }
  if (target.endsWith("/") || resolved_segments.length === 0) {
    throw new ValueError(
      `invalid generated PPTX package: invalid internal relationship target ${JSON.stringify(target)} in ${relationship_label(rels_part_name, rel_id)}`
    );
  }
  return resolved_segments.join("/");
}

function validate_relationship_graph(
  part_names: Set<string>,
  relationship_parts: Map<string, unknown>
): void {
  for (const [rels_part_name, parsed] of relationship_parts.entries()) {
    const source_part_name = source_part_for_relationships_part(rels_part_name);
    if (source_part_name && !part_names.has(source_part_name)) {
      throw new ValueError(
        `invalid generated PPTX package: relationships part ${JSON.stringify(rels_part_name)} refers to missing source part ${JSON.stringify(source_part_name)}`
      );
    }
    for (const relationship of relationships_in_part(parsed, rels_part_name)) {
      const rel_id = xml_attr(relationship, "Id");
      const target = xml_attr(relationship, "Target");
      if (!target) {
        throw new ValueError(
          `invalid generated PPTX package: missing relationship target in ${relationship_label(rels_part_name, rel_id)}`
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
          `invalid generated PPTX package: missing relationship target ${JSON.stringify(resolved_target)} referenced from ${relationship_label(rels_part_name, rel_id)}`
        );
      }
    }
  }
}

function _parse_package_xml(payload: string, part_name: string): unknown {
  if (/<!DOCTYPE|<!ENTITY/i.test(payload)) {
    throw new ValueError(
      `invalid generated PPTX package: disallowed XML construct in ${part_name}`
    );
  }
  const validation = XMLValidator.validate(payload);
  if (validation !== true) {
    const detail =
      typeof validation === "object"
        ? (validation.err?.msg ?? JSON.stringify(validation))
        : String(validation);
    throw new ValueError(
      `invalid generated PPTX package: XML parse failure in ${part_name}: ${detail}`
    );
  }
  return XML_PARSER.parse(payload);
}

function presentation_slide_relationship_ids(presentation_xml: unknown): string[] {
  const document = parsed_xml_node(presentation_xml, "presentation XML document");
  const presentation = parsed_xml_node(
    document["p:presentation"],
    "presentation XML root p:presentation"
  );
  const raw_list = presentation["p:sldIdLst"];
  if (raw_list === undefined) return [];
  const list = parsed_xml_node(raw_list, "presentation slide-id list p:sldIdLst");
  const slides = parsed_xml_nodes(list["p:sldId"], "presentation slide entry p:sldId");
  return slides.map((slide) => {
    const rel = xml_attr(slide, "r:id");
    if (!rel) throw new ValueError("invalid generated PPTX package: slide entry is missing r:id");
    return rel;
  });
}

function relationship_target_by_id(
  relationships_xml: unknown,
  rel_id: string,
  rels_part_name: string
): string {
  const match = relationships_in_part(relationships_xml, rels_part_name).find(
    (relationship) => xml_attr(relationship, "Id") === rel_id
  );
  const target = match ? xml_attr(match, "Target") : undefined;
  if (!target)
    throw new ValueError(
      `invalid generated PPTX package: missing presentation relationship target for ${JSON.stringify(rel_id)}`
    );
  return target;
}

function _read_u64_le(buffer: Buffer, offset: number): bigint {
  const low = BigInt(buffer.readUInt32LE(offset));
  const high = BigInt(buffer.readUInt32LE(offset + 4));
  return low | (high << 32n);
}

function _find_eocd_offset(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - ZIP_EOCD_SEARCH_LIMIT);
  for (let offset = buffer.length - ZIP_EOCD_FIXED_SIZE; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) continue;
    const comment_length = buffer.readUInt16LE(offset + 20);
    if (offset + ZIP_EOCD_FIXED_SIZE + comment_length === buffer.length) return offset;
  }
  throw new ValueError("invalid generated PPTX: ZIP end of central directory was not found");
}

function _zip_entry_name(bytes: Buffer, utf8: boolean): string {
  return bytes.toString(utf8 ? "utf8" : "latin1");
}

function _zip_central_directory_names(buffer: Buffer): string[] {
  const eocd_offset = _find_eocd_offset(buffer);
  const disk_number = buffer.readUInt16LE(eocd_offset + 4);
  const start_disk_number = buffer.readUInt16LE(eocd_offset + 6);
  if (disk_number !== 0 || start_disk_number !== 0) {
    throw new ValueError("invalid generated PPTX: multi-disk ZIP archives are not supported");
  }

  let entry_count = BigInt(buffer.readUInt16LE(eocd_offset + 10));
  let central_directory_size = BigInt(buffer.readUInt32LE(eocd_offset + 12));
  let central_directory_offset = BigInt(buffer.readUInt32LE(eocd_offset + 16));

  if (
    entry_count === 0xffffn ||
    central_directory_size === 0xffffffffn ||
    central_directory_offset === 0xffffffffn
  ) {
    const locator_offset = eocd_offset - ZIP64_EOCD_LOCATOR_SIZE;
    if (locator_offset < 0) {
      throw new ValueError("invalid generated PPTX: ZIP64 locator is missing");
    }
    if (buffer.readUInt32LE(locator_offset) !== ZIP64_EOCD_LOCATOR_SIGNATURE) {
      throw new ValueError("invalid generated PPTX: ZIP64 locator signature is missing");
    }
    const zip64_disk_number = buffer.readUInt32LE(locator_offset + 4);
    const zip64_eocd_offset = _read_u64_le(buffer, locator_offset + 8);
    const zip64_total_disks = buffer.readUInt32LE(locator_offset + 16);
    if (zip64_disk_number !== 0 || zip64_total_disks !== 1) {
      throw new ValueError("invalid generated PPTX: multi-disk ZIP64 archives are not supported");
    }
    if (
      zip64_eocd_offset > BigInt(buffer.length) ||
      zip64_eocd_offset + BigInt(ZIP64_EOCD_MIN_SIZE) > BigInt(buffer.length)
    ) {
      throw new ValueError(
        "invalid generated PPTX: ZIP64 end of central directory is out of bounds"
      );
    }
    const zip64_offset = Number(zip64_eocd_offset);
    if (buffer.readUInt32LE(zip64_offset) !== ZIP64_EOCD_SIGNATURE) {
      throw new ValueError(
        "invalid generated PPTX: ZIP64 end of central directory signature is missing"
      );
    }
    const zip64_record_size = _read_u64_le(buffer, zip64_offset + 4);
    if (zip64_eocd_offset + 12n + zip64_record_size > BigInt(buffer.length)) {
      throw new ValueError("invalid generated PPTX: ZIP64 end of central directory is truncated");
    }
    entry_count = _read_u64_le(buffer, zip64_offset + 32);
    central_directory_size = _read_u64_le(buffer, zip64_offset + 40);
    central_directory_offset = _read_u64_le(buffer, zip64_offset + 48);
  }

  const central_directory_end = central_directory_offset + central_directory_size;
  if (
    central_directory_offset > BigInt(buffer.length) ||
    central_directory_end > BigInt(buffer.length)
  ) {
    throw new ValueError("invalid generated PPTX: ZIP central directory is out of bounds");
  }

  const start = Number(central_directory_offset);
  const end = Number(central_directory_end);
  const names: string[] = [];
  let offset = start;
  let parsed_entries = 0n;

  while (offset < end && parsed_entries < entry_count) {
    if (offset + ZIP_CENTRAL_DIRECTORY_FILE_HEADER_FIXED_SIZE > end) {
      throw new ValueError("invalid generated PPTX: ZIP central directory entry is truncated");
    }
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_FILE_HEADER_SIGNATURE) {
      throw new ValueError(
        "invalid generated PPTX: ZIP central directory entry signature is missing"
      );
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const name_length = buffer.readUInt16LE(offset + 28);
    const extra_length = buffer.readUInt16LE(offset + 30);
    const comment_length = buffer.readUInt16LE(offset + 32);
    const entry_size =
      ZIP_CENTRAL_DIRECTORY_FILE_HEADER_FIXED_SIZE + name_length + extra_length + comment_length;
    if (offset + entry_size > end) {
      throw new ValueError("invalid generated PPTX: ZIP central directory entry exceeds bounds");
    }
    const name_bytes = buffer.subarray(
      offset + ZIP_CENTRAL_DIRECTORY_FILE_HEADER_FIXED_SIZE,
      offset + ZIP_CENTRAL_DIRECTORY_FILE_HEADER_FIXED_SIZE + name_length
    );
    names.push(_zip_entry_name(name_bytes, (flags & 0x0800) !== 0));
    offset += entry_size;
    parsed_entries += 1n;
  }

  if (offset < end) {
    if (
      offset + 6 <= end &&
      buffer.readUInt32LE(offset) === ZIP_CENTRAL_DIRECTORY_DIGITAL_SIGNATURE
    ) {
      const signature_size = buffer.readUInt16LE(offset + 4);
      offset += 6 + signature_size;
    }
  }
  if (offset !== end || parsed_entries !== entry_count) {
    throw new ValueError("invalid generated PPTX: ZIP central directory did not parse cleanly");
  }
  return names.filter((name) => !name.endsWith("/"));
}

async function slide_count_from_package(zip: JSZip, part_names: Set<string>): Promise<number> {
  const presentation_xml = zip.file("ppt/presentation.xml");
  const presentation_rels = zip.file("ppt/_rels/presentation.xml.rels");
  if (!presentation_xml || !presentation_rels)
    throw new ValueError("invalid generated PPTX package: presentation part is missing");
  const presentation_parsed = _parse_package_xml(
    await presentation_xml.async("string"),
    "ppt/presentation.xml"
  );
  const presentation_rels_parsed = _parse_package_xml(
    await presentation_rels.async("string"),
    "ppt/_rels/presentation.xml.rels"
  );
  const slide_ids = presentation_slide_relationship_ids(presentation_parsed);
  for (const rel_id of slide_ids) {
    const target = relationship_target_by_id(
      presentation_rels_parsed,
      rel_id,
      "ppt/_rels/presentation.xml.rels"
    );
    const resolved = resolve_internal_relationship_target(
      "ppt/_rels/presentation.xml.rels",
      "ppt/presentation.xml",
      target,
      rel_id
    );
    if (!part_names.has(resolved))
      throw new ValueError(
        `invalid generated PPTX package: missing slide part ${JSON.stringify(resolved)}`
      );
    const slide_part = zip.file(resolved);
    if (!slide_part)
      throw new ValueError(
        `invalid generated PPTX package: missing slide part ${JSON.stringify(resolved)}`
      );
    _parse_package_xml(await slide_part.async("string"), resolved);
  }
  return slide_ids.length;
}

export async function validate_pptx(
  path_to_pptx: string,
  expected_slide_count: number | null = null
): Promise<ValidationResult> {
  try {
    const buffer = fs.readFileSync(path_to_pptx);
    const raw_names = _zip_central_directory_names(buffer);
    if (raw_names.length !== new Set(raw_names).size) {
      const duplicates = [
        ...new Set(raw_names.filter((name, index) => raw_names.indexOf(name) !== index)),
      ].sort();
      throw new ValueError(`PPTX contains duplicate part names: ${JSON.stringify(duplicates)}`);
    }
    const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
    const missing = REQUIRED_PPTX_PARTS.filter((name) => !raw_names.includes(name));
    if (missing.length > 0)
      throw new ValueError(`PPTX is missing required parts: ${JSON.stringify(missing)}`);
    const part_names = new Set(raw_names);
    const xml_parts = raw_names.filter((name) => name.endsWith(".xml") || name.endsWith(".rels"));
    const relationship_parts = new Map<string, unknown>();
    for (const name of xml_parts) {
      const file = zip.file(name);
      if (!file) throw new ValueError(`PPTX package is missing XML part: ${name}`);
      const xml = await file.async("string");
      const parsed = _parse_package_xml(xml, name);
      if (name.endsWith(".rels")) relationship_parts.set(name, parsed);
    }
    validate_relationship_graph(part_names, relationship_parts);
    const slide_count = await slide_count_from_package(zip, part_names);
    if (expected_slide_count !== null && slide_count !== expected_slide_count) {
      throw new ValueError(
        `PPTX slide count mismatch: expected ${expected_slide_count}, got ${slide_count}`
      );
    }
    return {
      package_valid: true,
      reopen_valid: true,
      slide_count,
      required_parts: [...REQUIRED_PPTX_PARTS].sort(),
      xml_parts_checked: xml_parts.length,
      openxml_schema_validation: "not_performed",
    };
  } catch (error) {
    if (error instanceof ValueError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ValueError(`invalid generated PPTX: ${message}`);
  }
}

function reserveSiblingStagingPath(output_path: string): string {
  const target = path.resolve(output_path);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  for (let attempt = 0; attempt < MAX_STAGING_ATTEMPTS; attempt += 1) {
    const candidate = path.join(
      directory,
      `.${path.basename(target, ".pptx")}.${randomUUID()}.tmp.pptx`
    );
    try {
      const fd = fs.openSync(candidate, "wx", 0o600);
      fs.closeSync(fd);
      return candidate;
    } catch (error) {
      if (nodeErrorCode(error) !== "EEXIST") throw error;
    }
  }
  throw new Error(`Unable to reserve a unique PowerPoint staging file beside ${target}`);
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CancellationError();
}

async function withGenerationStage<T>(name: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof CancellationError ||
      error instanceof DocumentGenerationError ||
      error instanceof ValueError
    )
      throw error;
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new DocumentGenerationError(`${name}: ${reason}`);
  }
}

export async function publish_pptx_atomically(
  buffer: Buffer,
  output_path: string,
  staging_path: string | null = null,
  signal?: AbortSignal,
  expected_slide_count: number | null = null
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
    const validation = await validate_pptx(staging, expected_slide_count);
    throwIfAborted(signal);
    fs.renameSync(staging, target);
    return { path: target, validation };
  } finally {
    fs.rmSync(staging, { force: true });
  }
}

export async function generate(
  spec: Record<string, unknown>,
  signal?: AbortSignal,
  hooks: GeneratorHooks = {}
): Promise<PowerpointGenerationResult> {
  const opts = await withGenerationStage("options", async () => parse_options(spec));
  throwIfAborted(signal);
  const [loaded_slides, md_warnings] = await withGenerationStage("load_slides", async () =>
    _load_slides(spec, opts)
  );
  let slides = loaded_slides;
  slides.forEach((slide, index) => {
    slide._origin_index = index;
    slide._source_layout = slide.layout;
  });
  throwIfAborted(signal);
  let prepared_opts = opts;
  [prepared_opts, slides] = await withGenerationStage("preflight_assets", async () =>
    _preflight_new_assets(opts, slides)
  );
  throwIfAborted(signal);

  const builder = new PptxBuilder(prepared_opts);
  builder.warnings.push(...md_warnings);

  const { buffer } = await withGenerationStage("render", async () => {
    await hooks.before_render?.(signal);
    throwIfAborted(signal);
    let number = 1;
    for (const slide_spec of slides) {
      throwIfAborted(signal);
      number += await builder.build(slide_spec, number);
    }
    await hooks.before_pack?.(signal);
    throwIfAborted(signal);
    const output: unknown = await builder.prs.write({
      outputType: "nodebuffer",
      compression: false,
    });
    return { buffer: pptxWriteOutputToBuffer(output) };
  });

  throwIfAborted(signal);
  const published = await withGenerationStage("save_validate_publish", async () => {
    await hooks.before_publish?.(signal);
    throwIfAborted(signal);
    return publish_pptx_atomically(
      buffer,
      prepared_opts.output_path,
      prepared_opts.staging_path,
      signal,
      Object.values(builder.layouts_used).reduce((sum, count) => sum + count, 0)
    );
  });

  const font_records = prepared_opts.font_plan.map((choice) => ({ ...choice }));
  const continued_tables = Math.max(
    0,
    (builder.layouts_used.table ?? 0) - slides.filter((slide) => slide.layout === "table").length
  );
  const continued_content = Math.max(
    0,
    (builder.layouts_used.content ?? 0) -
      slides.filter((slide) => slide.layout === "content").length
  );
  const slide_count = Object.values(builder.layouts_used).reduce((sum, count) => sum + count, 0);

  return {
    path: path.resolve(published.path),
    slide_count,
    layouts_used: builder.layouts_used,
    theme: prepared_opts.theme_name,
    warnings: builder.warnings,
    validation: published.validation,
    resolved_palette: { ...builder.deck_default_design.palette },
    resolved_design: {
      deck_default: _resolved_design_record(builder.deck_default_design),
      slides: builder.resolved_design_slides,
    },
    fonts: font_records,
    font_plan: font_records,
    line_break_mode: prepared_opts.line_break_mode,
    normalization: {
      line_break_mode: prepared_opts.line_break_mode,
      split_slides: Math.max(0, slide_count - slides.length),
      continued_tables,
      continued_content_slides: continued_content,
    },
  };
}

export async function runInProcessGenerator(
  spec: Record<string, unknown>,
  signal?: AbortSignal,
  hooks: GeneratorHooks = {}
): Promise<PowerpointGenerationResult> {
  return generate(spec, signal, hooks);
}
