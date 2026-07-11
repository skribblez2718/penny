# Word Extension

Generate modern, professionally styled Word (`.docx`) documents from markdown — reports, proposals, guides, memos, resumes, or any other content the agent composes. Markdown is parsed with markdown-it-py (CommonMark + tables + strikethrough) and rendered through python-docx with a themed design system: styled headings with accent rules, banded tables, boxed code blocks, accent-bordered blockquotes, real hyperlinks, covers, TOCs, and page furniture.

## Tools

### `word_generate`

Render markdown into a themed `.docx`.

| Parameter                     | Required | Description                                                                                            |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `markdown`                    | one of   | Full markdown content to render.                                                                       |
| `markdown_path`               | one of   | Path to a `.md` file instead of inline content. Exactly one of `markdown`/`markdown_path` is required. |
| `title`                       | no       | Document title. Defaults to the first H1 (then not repeated in the body), else "Document".             |
| `subtitle`                    | no       | Muted subtitle under the title.                                                                        |
| `author`                      | no       | Shown on the title block / cover meta line.                                                            |
| `date`                        | no       | Meta line date; defaults to today when `author` or `cover_page` is set.                                |
| `theme`                       | no       | `executive` (default) / `modern` / `minimal` / `editorial` / `tech`.                                   |
| `accent_color`                | no       | Hex accent override, e.g. `0E7490` (`#` optional).                                                     |
| `font_size_pt`                | no       | Body size, 8–14 (default 11).                                                                          |
| `line_spacing`                | no       | 1.0–2.0 (default 1.15).                                                                                |
| `margin_inches`               | no       | 0.4–2.0 (default 1.0).                                                                                 |
| `orientation`                 | no       | `portrait` (default) / `landscape`.                                                                    |
| `page_size`                   | no       | `letter` (default) / `a4`.                                                                             |
| `cover_page`                  | no       | Standalone cover page, then a page break (default false).                                              |
| `include_toc`                 | no       | Table of Contents for heading levels 1–3 (default false).                                              |
| `include_page_numbers`        | no       | Footer page numbers (default true).                                                                    |
| `header_text` / `footer_text` | no       | Small muted page header (right) / footer (left) text.                                                  |
| `table_style`                 | no       | `banded` (default) / `minimal` / `grid` / `none`.                                                      |
| `output_path`                 | no       | Destination; when omitted, writes to the OS temp dir (`…/penny/word/<slug>_<timestamp>.docx`), never the project tree.                              |

**Example**

```typescript
word_generate({
  markdown: "# Quarterly Review\n\n## Summary\n\nWe shipped **14 releases**...",
  subtitle: "Q2 2026",
  author: "Platform Team",
  theme: "modern",
  cover_page: true,
  include_toc: true,
  footer_text: "Confidential",
});
```

## Themes

| Theme       | Accent              | Fonts                   | Feel              |
| ----------- | ------------------- | ----------------------- | ----------------- |
| `executive` | deep navy `1F3A5F`  | Calibri Light / Calibri | boardroom default |
| `modern`    | indigo `4F46E5`     | Segoe UI                | product / SaaS    |
| `minimal`   | near-black `111827` | Arial                   | monochrome, quiet |
| `editorial` | rust `7C2D12`       | Georgia                 | serif, long-form  |
| `tech`      | teal `0F766E`       | Segoe UI / Calibri      | engineering docs  |

`accent_color` swaps the accent while keeping the rest of the theme.

## Markdown support

Headings H1–H6, paragraphs, **bold**, _italic_, `inline code` (shaded), ~~strikethrough~~, [links](https://example.com) (real hyperlinks), nested bullet lists, numbered lists (manually numbered so restarts are always correct), tables, fenced code blocks (boxed, monospace), blockquotes (accent left border), horizontal rules, and images (`![caption](path)`, scaled to fit; missing files degrade to a placeholder plus a warning in the result).

## Dependencies

Python packages in the project venv (`.venv`): `python-docx`, `markdown-it-py`, `lxml`, `pillow`. Installed by `scripts/setup/init-external-tools.sh`. No TypeScript runtime dependencies.

## Configuration

| Env var                   | Purpose                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `PROJECT_ROOT`            | Repo root used for the venv, script, and default output paths (falls back to cwd). |
| `PI_VENV_PYTHON`          | Explicit python interpreter override.                                              |
| `PENNY_DOCGEN_TIMEOUT_MS` | Generator timeout (default 90000).                                                 |

Default output directory (when `output_path` is omitted): the OS temp dir, `…/penny/word/`.

## Testing

```bash
npm run test:unit
```
