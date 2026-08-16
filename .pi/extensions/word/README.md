# Word Extension

Generate professionally styled, structurally validated Word (`.docx`) documents from Markdown. The TypeScript extension validates arguments and manages the Python process; `generate_docx.py` parses Markdown, renders through python-docx, validates the OOXML package, and atomically publishes the final file.

## Tool

### `word_generate`

Exactly one of `markdown` or `markdown_path` is required.

| Parameter                     | Required | Description                                                                                                                                                              |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `markdown`                    | one of   | Full Markdown content.                                                                                                                                                   |
| `markdown_path`               | one of   | UTF-8 Markdown file. Relative paths resolve from the project root.                                                                                                       |
| `title`                       | no       | Document title. Defaults to a leading H1.                                                                                                                                |
| `subtitle`                    | no       | Subtitle below the title.                                                                                                                                                |
| `author` / `date`             | no       | Title metadata. Date defaults to today when needed.                                                                                                                      |
| `theme`                       | no       | `executive` (default), `modern`, `minimal`, `editorial`, or `tech`.                                                                                                      |
| `accent_color`                | no       | Six-digit hex accent. The complete palette is regenerated with contrast-safe text colors.                                                                                |
| `font_size_pt`                | no       | Body size, 8–14 pt (default 11). Headings and supporting text scale from it.                                                                                             |
| `line_spacing`                | no       | 1.0–2.0 (default 1.15).                                                                                                                                                  |
| `line_break_mode`             | no       | `preserve` (default) turns a single newline into a Word line break; `commonmark` folds it to a space. Explicit hard breaks and `<br>` are always preserved.              |
| `margin_inches`               | no       | Uniform margin, 0.4–2.0 inches (default 1.0).                                                                                                                            |
| `orientation`                 | no       | `portrait` (default) or `landscape`.                                                                                                                                     |
| `page_size`                   | no       | `letter` (default) or `a4`.                                                                                                                                              |
| `title_mode`                  | no       | `auto` (default), `none`, `inline`, or `cover`. `none` retains a leading H1 in the body. A cover is isolated from body headers/footers and restarts body numbering at 1. |
| `cover_page`                  | no       | Backward-compatible alias for `title_mode: "cover"` while `title_mode` is `auto`.                                                                                        |
| `include_toc`                 | no       | Inserts a Word TOC field and requests field refresh on open. Some viewers may still require a manual update.                                                             |
| `include_page_numbers`        | no       | Footer page numbers (default true).                                                                                                                                      |
| `header_text` / `footer_text` | no       | Small running header/footer text.                                                                                                                                        |
| `table_style`                 | no       | `banded` (default), `minimal`, `grid`, or `none`.                                                                                                                        |
| `table_layout`                | no       | `content` (default) uses bounded content-aware widths; `equal` retains equal-width compatibility behavior.                                                               |
| `output_path`                 | no       | Destination. Relative paths resolve from the project root. When omitted, a unique file is written under the OS temp directory (`…/penny/word/`).                         |

```typescript
word_generate({
  markdown: "# Quarterly Review\n\n## Summary\n\nWe shipped **14 releases**.",
  subtitle: "Q2 2026",
  author: "Platform Team",
  theme: "modern",
  title_mode: "cover",
  include_toc: true,
  footer_text: "Confidential",
});
```

## Rendering behavior

- CommonMark plus tables and strikethrough
- Headings H1–H6 with a body-relative monotonic type scale
- Paragraph and character styles so ordinary text inherits document typography
- Bold, italic, strikethrough, inline code, and real hyperlinks
- Preserved soft breaks by default, including breaks inside hyperlinks
- Bulleted and ordered lists; continuation paragraphs remain unmarked
- Content-aware tables with Markdown alignment, repeating header rows, compact cells, and non-splitting rows
- Blockquotes, horizontal rules, and continuous code blocks
- Local raster images sized to both page width and height; inline images remain in authored order and receive alt text
- Cover/body section isolation and body page-number restart
- TOC fields marked for update on open

The result includes validation evidence, normalization choices, the resolved palette, content statistics, and warnings.

## Reliability guarantees

The generator writes to a unique same-directory staging file, then checks:

1. ZIP integrity and CRCs
2. Required OPC/OOXML package parts
3. Every XML and relationship part parses
4. python-docx can reopen the package

Only a validated package replaces the target. A failed generation leaves an existing target unchanged. This publication guarantee assumes normal local-filesystem `replace` semantics; it does not claim stronger guarantees for every network or virtual filesystem.

## Dependencies

Word runtime dependencies are first-class locked project dependencies in `pyproject.toml` and `uv.lock`:

- `python-docx>=1.2,<1.3`
- `markdown-it-py>=4,<5`
- `pillow>=12,<13`

TypeBox is a runtime dependency of the Word workspace package. No manual `uv pip install` step is required.

```bash
uv sync --extra dev --frozen
bun install --frozen-lockfile
```

## Configuration

| Environment variable      | Purpose                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PROJECT_ROOT`            | Optional project-root override. Otherwise the root is discovered from the extension module, not the process CWD. |
| `PI_VENV_PYTHON`          | Optional Python interpreter override. Standard POSIX and Windows venv layouts are discovered automatically.      |
| `PENNY_DOCGEN_TIMEOUT_MS` | Generator timeout in milliseconds (default 90000).                                                               |

## Testing

```bash
# TypeScript behavior
(cd .pi/extensions/word && bun run test:unit)

# Python rendering and OOXML structure
uv run --frozen python -m pytest \
  .pi/extensions/word/tests/python \
  -p no:cacheprovider --tb=short -q

# Real TypeScript → Python boundary, including cancellation and timeout
(cd .pi/extensions/word && bun run test:integration)
```

The focused GitHub Actions workflow runs these checks on Linux, macOS, and Windows. A Linux LibreOffice conversion smoke test adds an independent compatibility check without making LibreOffice a runtime dependency. Visual release review remains a separate human check.

## Known viewer constraints

- A TOC is a Word field. The document requests refresh on open, but viewers that do not update fields may still show placeholder text until the field is refreshed.
- Font availability varies by operating system. Word or LibreOffice may substitute a theme font; structural tests intentionally do not depend on proprietary fonts.
- Ordered lists retain explicit restart-safe markers. Migration to editable native Word numbering is a separate compatibility-sensitive change.
