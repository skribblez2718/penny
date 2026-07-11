# PowerPoint Extension

Generate modern, professionally styled 16:9 PowerPoint (`.pptx`) presentations from a structured slide list or markdown. Slides are drawn on blank layouts with an explicit design system — accent bars, kickers, full-bleed section dividers, DrawingML bullets with proper hanging indents, banded tables, quote and image layouts — through python-pptx. Shares its theme vocabulary with the sibling `word` extension.

## Tools

### `powerpoint_generate`

Render slides into a themed `.pptx`.

| Parameter         | Required | Description                                                                     |
| ----------------- | -------- | ------------------------------------------------------------------------------- |
| `slides`          | one of   | Structured slide array (preferred — full control).                              |
| `markdown`        | one of   | Markdown convenience mode. Exactly one of `slides`/`markdown` is required.      |
| `title`           | no       | Deck title — auto title slide in markdown mode, and the filename slug.          |
| `subtitle`        | no       | Fallback subtitle for the title slide.                                          |
| `author` / `date` | no       | Title slide meta line ("author · date").                                        |
| `theme`           | no       | `executive` (default) / `modern` / `minimal` / `editorial` / `tech`.            |
| `accent_color`    | no       | Hex accent override, e.g. `B45309` (`#` optional).                              |
| `footer_text`     | no       | Muted footer text bottom-left of content slides.                                |
| `slide_numbers`   | no       | Bottom-right numbers (default true; skipped on title/section/closing).          |
| `output_path`     | no       | Destination; when omitted, writes to the OS temp dir (`…/penny/powerpoint/<slug>_<timestamp>.pptx`), never the project tree. |

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

| Layout       | Fields                                          | Look                                               |
| ------------ | ----------------------------------------------- | -------------------------------------------------- |
| `title`      | title, subtitle, author, date                   | accent bar, 40pt title, decorative corner          |
| `section`    | title                                           | full-bleed accent, auto-numbered "01" watermark    |
| `content`    | kicker, title, body, bullets                    | kicker caps, accent underline, 3-level bullets     |
| `two_column` | title, left, right (`{heading, body, bullets}`) | two balanced columns with accent headings          |
| `table`      | title, table (`{headers, rows}`)                | accent header row, banded body rows (max 10 shown) |
| `quote`      | quote, attribution                              | oversized accent quote glyph, centered italic      |
| `image`      | title, image_path, caption                      | auto-fit centered image, muted caption             |
| `closing`    | title, subtitle                                 | full-bleed accent thank-you                        |

Bullets accept plain strings or `{ text, level (0–2), bold }`. Inline `**bold**`, `*italic*`, `` `code` ``, and `~~strikethrough~~` are honored in bullets, body, table cells, and quotes. Any slide may carry `notes` (speaker notes).

## Markdown mode rules

1. A leading `# H1` (+ optional following paragraph) becomes the **title** slide.
2. `---` immediately before a `## H2` makes that H2 a **section** divider; otherwise each `## H2` starts a new **content** slide.
3. Within a slide: paragraphs → body, lists → bullets (nesting capped at 2), `### H3` → bold bullet, fenced code → shaded **code panel**, a table → **table** slide, a blockquote → **quote** slide (trailing `— name` becomes the attribution), each image → an **image** slide.
4. Mixed content under one heading splits into consecutive slides (quote → content → table → images) so nothing is dropped; slides with more than 7 bullets split into "(cont.)" slides.

## Themes

| Theme       | Accent              | Fonts                   |
| ----------- | ------------------- | ----------------------- |
| `executive` | deep navy `1F3A5F`  | Calibri Light / Calibri |
| `modern`    | indigo `4F46E5`     | Segoe UI                |
| `minimal`   | near-black `111827` | Arial                   |
| `editorial` | rust `7C2D12`       | Georgia                 |
| `tech`      | teal `0F766E`       | Segoe UI / Calibri      |

## Dependencies

Python packages in the project venv (`.venv`): `python-pptx`, `markdown-it-py`, `lxml`, `pillow`. Installed by `scripts/setup/init-external-tools.sh`. No TypeScript runtime dependencies.

## Configuration

| Env var                   | Purpose                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `PROJECT_ROOT`            | Repo root used for the venv, script, and default output paths (falls back to cwd). |
| `PI_VENV_PYTHON`          | Explicit python interpreter override.                                              |
| `PENNY_DOCGEN_TIMEOUT_MS` | Generator timeout (default 90000).                                                 |

Default output directory (when `output_path` is omitted): the OS temp dir, `…/penny/powerpoint/`.

## Testing

```bash
npm run test:unit
```
