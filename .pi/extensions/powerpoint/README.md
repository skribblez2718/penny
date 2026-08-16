# PowerPoint Extension

Generate modern, professionally styled 16:9 PowerPoint (`.pptx`) presentations from a structured slide list or Markdown. Slides are drawn as editable PowerPoint shapes on blank layouts through python-pptx. The renderer supports the five legacy theme seeds plus an additive custom-design tier for semantic palettes, local backgrounds, one mark, and three composed image/text layouts.

## Tools

### `powerpoint_generate`

Render slides into a `.pptx`.

| Parameter             | Required | Description                                                                                                                                          |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slides`              | one of   | Structured slide array (preferred for full control).                                                                                                 |
| `markdown`            | one of   | Markdown convenience mode. Exactly one of `slides`/`markdown` is required.                                                                           |
| `title`               | no       | Deck title—auto title slide in Markdown mode and the filename slug.                                                                                  |
| `subtitle`            | no       | Fallback subtitle for the title slide.                                                                                                               |
| `author` / `date`     | no       | Title slide meta line (`author · date`).                                                                                                             |
| `theme`               | no       | Legacy seed: `executive` (default), `modern`, `minimal`, `editorial`, or `tech`.                                                                     |
| `accent_color`        | no       | Legacy six-digit hex accent override (`#` optional). Rejected when `design.palette.accent` is also supplied.                                         |
| `design`              | no       | Deck defaults: `palette`, local `background`, and one positioned `mark`.                                                                             |
| `allowed_image_roots` | no       | Nonempty list of additional roots allowed for new background/media/mark assets. The project root remains allowed by default.                         |
| `line_break_mode`     | no       | `preserve` (default) emits PowerPoint line breaks for soft breaks; `commonmark` folds them to spaces. Hard/`<br>` breaks survive.                    |
| `footer_text`         | no       | Muted footer text at the bottom-left of content slides.                                                                                              |
| `slide_numbers`       | no       | Bottom-right numbers (default true; skipped on title/section/closing).                                                                               |
| `output_path`         | no       | Destination; when omitted, writes to the OS temp directory (`…/penny/powerpoint/<slug>_<timestamp>_<invocation-uuid>.pptx`), never the project tree. |

**Custom-design example**

```typescript
powerpoint_generate({
  theme: "modern", // legacy font/color seed
  design: {
    palette: {
      canvas: "0B1020",
      surface: "151F32",
      accent: "38BDF8",
      text: "F8FAFC",
      muted_text: "A8B4C8",
    },
    background: {
      path: "assets/ambient-grid.jpg",
      fit: "crop",
      focal_point: { x: 0.55, y: 0.45 },
      overlay: { color: "000000", opacity: 0.4 },
    },
    mark: {
      path: "assets/mark.png",
      x: 0.9,
      y: 0.05,
      width: 0.06,
      height: 0.06,
      fit: "contain",
    },
  },
  allowed_image_roots: ["shared-assets"],
  slides: [
    {
      layout: "image_left",
      kicker: "Architecture",
      title: "Current state",
      body: "The text remains **editable**.",
      bullets: ["Measured pagination", "Repeated media on continuation pages"],
      media: { path: "assets/diagram.png", fit: "contain" },
    },
    {
      layout: "image_right",
      title: "A slide without the inherited background",
      body: "The mark is still inherited.",
      media: { path: "assets/detail.jpg" },
      design: { background: null },
    },
    {
      layout: "full_bleed",
      title: "A narrow operating window",
      body: "Full-bleed media replaces the inherited background.",
      media: {
        path: "assets/night-city.jpg",
        focal_point: { x: 0.72, y: 0.48 },
        overlay: { opacity: 0.35 },
      },
      design: { mark: null },
    },
  ],
});
```

## Slide layouts

| Layout        | Fields                                          | Look                                                    |
| ------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `title`       | title, subtitle, author, date                   | accent bar, 40pt title, decorative corner               |
| `section`     | title                                           | full-accent divider and numbered watermark              |
| `content`     | kicker, title, body, bullets                    | kicker caps, accent underline, three-level bullets      |
| `two_column`  | title, left, right (`{heading, body, bullets}`) | two balanced columns with accent headings               |
| `table`       | title, table (`{headers, rows}`)                | accent header, banded rows, continuation slides         |
| `quote`       | quote, attribution                              | oversized accent quote glyph, centered italic text      |
| `image`       | title, image_path, caption                      | legacy contained image and muted caption                |
| `closing`     | title, subtitle                                 | full-accent thank-you                                   |
| `image_left`  | title, kicker, body, bullets, media, caption    | media at left and an opaque editable-text pane at right |
| `image_right` | title, kicker, body, bullets, media, caption    | opaque editable-text pane at left and media at right    |
| `full_bleed`  | title, kicker, body, bullets, media, caption    | full-canvas media with an opaque editable-text panel    |

Bullets accept strings or `{ text, level (0–2), bold }`. Inline `**bold**`, `*italic*`, `` `code` ``, and `~~strikethrough~~` are honored in bullets, body, table cells, and quotes. Any slide may carry speaker `notes`.

### Composed-layout contract

`image_left`, `image_right`, and `full_bleed` are structured-input-only. They require `media` and support `title`, `kicker`, `body`, `bullets`, `caption`, and `notes`. They reject incompatible table, `left`/`right` column, quote/attribution, code, and legacy `image_path` fields rather than ignoring them. Text is emitted as ordinary editable text boxes. Content may paginate; continuation slides retain the effective design and repeat their media while preserving all content.

Side layouts place text on an opaque `surface` pane. `full_bleed` replaces the inherited background image with its `media` and places text on an opaque `surface` panel. Image overlay opacity is visual styling, not the accessibility mechanism; meaningful text does not rely on arbitrary image pixels for contrast.

## Custom design

### Strict reusable objects

- A hex color is exactly six hexadecimal digits with an optional leading `#`.
- `FocalPoint` is `{ x, y }`, each normalized to `0..1`.
- `Overlay` is `{ color?, opacity }`; `opacity` is required whenever the object is present and is bounded to `0..1`.
- `MediaSpec` is `{ path, fit?, focal_point?, overlay? }`, where `path` is nonempty and `fit` is `crop` or `contain`.
- `PalettePatch` accepts only `canvas`, `surface`, `accent`, `text`, and `muted_text`.
- `PlacedImage` accepts only `path`, normalized `x`, `y`, `width`, `height`, optional `fit`, and optional `focal_point`; width and height must be greater than zero.
- Deck `design` accepts only `palette`, `background`, and `mark`.
- Slide `design` accepts the same fields, but `background: null` and `mark: null` explicitly remove inherited values.

All these nested objects are closed to unknown properties.

### Palette and inheritance

The existing five themes and `accent_color` remain legacy seeds. `design.palette` is the preferred customization surface and supports genuinely dark solid canvases. Do not pass both `accent_color` and `design.palette.accent`; the combination is rejected rather than assigned an implicit precedence. No new named dark themes or templates are introduced.

Deck design is the default for every slide. A slide palette merges field by field. A non-null slide background or mark replaces the inherited object; `null` removes it. Continuation pages inherit the source slide's resolved palette, background, mark, and composed media.

Requested `text` and `muted_text` colors are preferences. If necessary, the renderer contrast-corrects them to at least **4.5:1** against the opaque role surface where they are used. The requested `accent` remains exact for decorative fills; derived `accent_text` and `link` roles are corrected independently when the fill color is not readable on a surface. Actual colors, contrast values, and every requested-role correction are reported in `resolved_design` for each output slide.

### Local image assets

The new `design.background`, `design.mark`, and slide `media` paths accept only static PNG or JPEG files. They fail closed when missing, unreadable, animated, unsupported, outside the allowed roots, larger than **25 MiB**, or larger than **40 megapixels**. The canonical project root is allowed by default; callers may add roots explicitly with `allowed_image_roots`. Remote, URI, and data assets are not supported.

Accepted assets are snapshotted and re-encoded before embedding, stripping metadata. Source paths are not included in `resolved_design`. Legacy `image`/`image_path` behavior remains unchanged, including its compatibility placeholder for a missing image.

Fit defaults are contextual:

- deck background and `full_bleed` media: `crop`;
- `image_left`/`image_right` media and marks: `contain`.

`crop` preserves aspect ratio and uses the normalized focal point to select the visible source region. `contain` preserves aspect ratio within its frame. A background may also carry an optional overlay; one positioned mark is supported per effective slide.

### Authoritative semantic validation

TypeBox validates the public object shapes, ranges, literals, and closed nested fields. Some cross-field rules cannot be represented there: `x + width <= 1` (and the corresponding vertical bound), required `media` for composed layouts, the `accent_color`/`design.palette.accent` conflict, and layout-incompatible fields. The Python renderer is authoritative for those semantic checks, including direct JSON invocation, and rejects them before publication.

## Markdown mode rules

1. A leading `# H1` plus an optional following paragraph becomes the title slide.
2. `---` immediately before a `## H2` makes that H2 a section divider; otherwise each `## H2` starts a content slide.
3. Within a slide: paragraphs become body, lists become bullets (nesting capped at 2), `### H3` becomes a bold bullet, fenced code becomes a shaded code panel, a table becomes a table slide, a blockquote becomes a quote slide, and each image becomes a legacy image slide.
4. Mixed content under one heading splits into consecutive slides. Paragraphs, bullets, code lines, and table rows paginate by conservative height estimates, and tables repeat their header.

Markdown classification is unchanged by custom design. Deck design defaults still apply to Markdown-generated slides, but Markdown does not infer any composed layout. An image in its own paragraph remains a legacy image slide; mixed text-and-image paragraphs and raw HTML images still fail closed.

## Themes

| Theme       | Accent              | Fonts                   |
| ----------- | ------------------- | ----------------------- |
| `executive` | deep navy `1F3A5F`  | Calibri Light / Calibri |
| `modern`    | indigo `4F46E5`     | Segoe UI                |
| `minimal`   | near-black `111827` | Arial                   |
| `editorial` | rust `7C2D12`       | Georgia                 |
| `tech`      | teal `0F766E`       | Segoe UI / Calibri      |

Themes remain compatibility seeds for fonts and initial colors; they are not templates or PowerPoint masters.

## Dependencies

PowerPoint runtime dependencies are locked project dependencies: `python-pptx`, `markdown-it-py`, `lxml`, and `pillow`. Install the project environments with:

```bash
uv sync --extra dev --frozen
bun install --frozen-lockfile
```

No manual package-install step is required.

## Configuration

| Environment variable      | Purpose                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PROJECT_ROOT`            | Optional project-root override. Otherwise the root is discovered from the extension module, not the process CWD. |
| `PI_VENV_PYTHON`          | Explicit Python interpreter override.                                                                            |
| `PENNY_DOCGEN_TIMEOUT_MS` | Generator timeout (default 90000 ms).                                                                            |

## Reliability, validation, and results

The renderer writes to a unique staging path beside the target, validates ZIP CRCs, required OPC/PresentationML parts, entity-safe/no-network XML well-formedness, python-pptx reopening, and slide count, then atomically replaces the destination. Pre-publication failures preserve an existing target and remove only the invocation's staging file. Cancellation or timeout can race after validated atomic replacement; in that case the caller may receive a cancellation/error while a complete valid final deck remains.

Generation does not truncate table rows, code lines, or composed-layout content. Content that cannot fit at the readability floors and cannot be split at a safe boundary fails without publishing. New visual-critical assets and semantic design errors are validated before atomic publication.

Results preserve all existing fields and add `resolved_design`: `deck_default` plus a path-free `slides` record for each output slide. It reports effective palette roles, contrast/corrections, background/media treatment, and mark presence. Package reopening and structural checks are not a claim of pixel-identical rendering in every viewer.

Templates/masters, remote assets, generic collages, animation, transitions, and automatic Markdown composition are out of scope for this tier.

## Testing

```bash
# TypeScript schema/helpers
(cd .pi/extensions/powerpoint && bun run test:unit)

# Python rendering, pagination, OOXML, palette/font/image, and atomicity
uv run --frozen python -m pytest \
  .pi/extensions/powerpoint/tests/python \
  -p no:cacheprovider --tb=short -q

# Real TypeScript → Python lifecycle, design semantics, and cancellation boundary
(cd .pi/extensions/powerpoint && bun run test:integration)

# PowerPoint TypeScript static check
(cd .pi/extensions/powerpoint && bunx tsc --noEmit)
```
