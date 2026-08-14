# PowerPoint Extension

Generate modern, professionally styled 16:9 PowerPoint (`.pptx`) presentations from a structured slide list or markdown. Slides are drawn on blank layouts with an explicit design system — accent bars, kickers, full-bleed section dividers, DrawingML bullets with proper hanging indents, banded tables, quote and image layouts — through python-pptx. Shares its theme vocabulary with the sibling `word` extension.

## Tools

### `powerpoint_generate`

Render slides into a themed `.pptx`.

| Parameter         | Required | Description                                                                                                                                    |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `slides`          | one of   | Structured slide array (preferred — full control).                                                                                             |
| `markdown`        | one of   | Markdown convenience mode. Exactly one of `slides`/`markdown` is required.                                                                     |
| `title`           | no       | Deck title — auto title slide in markdown mode, and the filename slug.                                                                         |
| `subtitle`        | no       | Fallback subtitle for the title slide.                                                                                                         |
| `author` / `date` | no       | Title slide meta line ("author · date").                                                                                                       |
| `theme`           | no       | `executive` (default) / `modern` / `minimal` / `editorial` / `tech`.                                                                           |
| `accent_color`    | no       | Hex accent override, e.g. `B45309` (`#` optional); dependent palette colors and foreground contrast are regenerated.                           |
| `line_break_mode` | no       | `preserve` (default) emits PowerPoint line breaks for soft breaks; `commonmark` folds them to spaces. Hard/`<br>` survive.                     |
| `footer_text`     | no       | Muted footer text bottom-left of content slides.                                                                                               |
| `slide_numbers`   | no       | Bottom-right numbers (default true; skipped on title/section/closing).                                                                         |
| `output_path`     | no       | Destination; when omitted, writes to the OS temp dir (`…/penny/powerpoint/<slug>_<timestamp>_<invocation-uuid>.pptx`), never the project tree. |

**Example (structured)**

```typescript
powerpoint_generate({
  theme: "modern",
  footer_text: "Internal",
  slides: [
    { layout: "title", title: "Platform Review", subtitle: "H2 roadmap", author: "Platform Team" },
    { layout: "section", title: "Where we are" },
    {
      layout: "content",
      kicker: "Architecture",
      title: "Current State",
      body: "The platform runs **28 extensions**.",
      bullets: ["Single engine substrate", { text: "MemPalace memory", level: 1 }],
      notes: "Mention the venv migration.",
    },
    {
      layout: "table",
      title: "Coverage",
      table: { headers: ["Area", "N"], rows: [["Security", "9"]] },
    },
    { layout: "quote", quote: "The engine is the single substrate.", attribution: "Design notes" },
    { layout: "closing", title: "Thank you", subtitle: "Questions → #penny-dev" },
  ],
});
```

## Slide layouts

| Layout       | Fields                                          | Look                                            |
| ------------ | ----------------------------------------------- | ----------------------------------------------- |
| `title`      | title, subtitle, author, date                   | accent bar, 40pt title, decorative corner       |
| `section`    | title                                           | full-bleed accent, auto-numbered "01" watermark |
| `content`    | kicker, title, body, bullets                    | kicker caps, accent underline, 3-level bullets  |
| `two_column` | title, left, right (`{heading, body, bullets}`) | two balanced columns with accent headings       |
| `table`      | title, table (`{headers, rows}`)                | accent header, banded rows, continuation slides |
| `quote`      | quote, attribution                              | oversized accent quote glyph, centered italic   |
| `image`      | title, image_path, caption                      | auto-fit centered image, muted caption          |
| `closing`    | title, subtitle                                 | full-bleed accent thank-you                     |

Bullets accept plain strings or `{ text, level (0–2), bold }`. Inline `**bold**`, `*italic*`, `` `code` ``, and `~~strikethrough~~` are honored in bullets, body, table cells, and quotes. Any slide may carry `notes` (speaker notes).

## Markdown mode rules

1. A leading `# H1` (+ optional following paragraph) becomes the **title** slide.
2. `---` immediately before a `## H2` makes that H2 a **section** divider; otherwise each `## H2` starts a new **content** slide.
3. Within a slide: paragraphs → body, lists → bullets (nesting capped at 2), `### H3` → bold bullet, fenced code → shaded **code panel**, a table → **table** slide, a blockquote → **quote** slide (trailing `— name` becomes the attribution), each image → an **image** slide.
4. Mixed content under one heading splits into consecutive slides (quote → content → table → images). Paragraphs, bullets, code lines, and table rows paginate by conservative height estimates rather than fixed item counts. Continuation slides preserve the contextual title and tables repeat their header.

Soft breaks follow `line_break_mode`; hard breaks and safe `<br>` forms always become native PowerPoint line breaks. Blank-line Markdown paragraphs remain separate PowerPoint paragraphs, and links remain clickable. An image in its own paragraph remains supported. Mixed text-and-image paragraphs and raw HTML images fail explicitly instead of silently losing the image; unsupported raw HTML also fails closed. Composed text-image layouts are deferred.

## Themes

| Theme       | Accent              | Fonts                   |
| ----------- | ------------------- | ----------------------- |
| `executive` | deep navy `1F3A5F`  | Calibri Light / Calibri |
| `modern`    | indigo `4F46E5`     | Segoe UI                |
| `minimal`   | near-black `111827` | Arial                   |
| `editorial` | rust `7C2D12`       | Georgia                 |
| `tech`      | teal `0F766E`       | Segoe UI / Calibri      |

## Dependencies

PowerPoint runtime dependencies are first-class locked project dependencies in `pyproject.toml` and `uv.lock`: `python-pptx`, `markdown-it-py`, `lxml`, and `pillow`. Install the project environments with:

```bash
uv sync --extra dev --frozen
bun install --frozen-lockfile
```

No manual package-install step is required.

## Configuration

| Env var                   | Purpose                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PROJECT_ROOT`            | Optional project-root override. Otherwise the root is discovered from the extension module, not the process CWD. |
| `PI_VENV_PYTHON`          | Explicit python interpreter override.                                                                            |
| `PENNY_DOCGEN_TIMEOUT_MS` | Generator timeout (default 90000).                                                                               |

Default output directory (when `output_path` is omitted): the OS temp dir, `…/penny/powerpoint/`. Each default filename carries a full invocation UUID so concurrent calls cannot derive the same destination.

## Reliability and validation

The renderer writes to a unique staging path beside the target, validates ZIP CRCs, required OPC/PresentationML parts, entity-safe/no-network XML well-formedness, python-pptx reopening, and slide count, then atomically replaces the destination. Pre-publication failures preserve an existing target and remove only the invocation's staging file. Cancellation or timeout can race after validated atomic replacement; in that case the caller may receive a cancellation/error while a complete valid final deck remains. The guarantee is no partial or corrupt publication, not that every cancelled call leaves no final file.

Generation never truncates table rows or code lines. Content that cannot fit at the documented readability floors and cannot be split at a safe paragraph, bullet, source-line, or table-row boundary fails without publishing. Preflight uses the resolved regular, bold, italic, bold-italic, and mono style metrics used by inline runs; unavailable style metrics fail closed rather than relying on fixed width multipliers. Existing unreadable images fail; missing paths remain visible placeholders for compatibility. Images use EXIF-aware `contain` sizing and report effective resolution below 96 PPI. Results include validation, normalization, resolved palette, font-resolution, and warning telemetry.

This Priority-0 release provides structural reliability and conservative layout preflight. Template/master inheritance, real ordered numbering, composed text-image layouts, content-aware table columns, rendered PDF/PNG visual QA, transitions, and animations remain deferred.

## Testing

```bash
# TypeScript schema/helpers
(cd .pi/extensions/powerpoint && bun run test:unit)

# Python rendering, pagination, OOXML, palette/font/image, and atomicity
uv run --frozen python -m pytest \
  .pi/extensions/powerpoint/tests/python \
  -p no:cacheprovider --tb=short -q

# Real TypeScript → Python lifecycle and cancellation boundary
(cd .pi/extensions/powerpoint && bun run test:integration)
```
