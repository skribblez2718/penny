#!/usr/bin/env python3
"""Generate a professionally styled PowerPoint (.pptx) presentation.

Reads a JSON spec from stdin (structured `slides` list or `markdown`), renders
16:9 slides through python-pptx with a themed design system drawn on blank
layouts (no template placeholders), writes the file, and prints a JSON result
to stdout. Called by the powerpoint extension's powerpoint_generate tool.

Markdown-to-slides rules (kept in sync with the tool description and README):
1. A leading `# H1` (+ optional following paragraph) becomes the title slide.
2. `---` immediately before a `## H2` makes that H2 a section divider slide;
   otherwise each `## H2` starts a new content slide.
3. Within a slide: paragraphs -> body, lists -> bullets (nesting capped at 2),
   `### H3` -> bold level-0 bullet, fenced code -> shaded code panel, a table
   -> table slide, a blockquote -> quote slide (trailing `— name` line becomes
   the attribution), each image -> an image slide. Mixed content under one
   heading splits into consecutive slides (quote, content, table, images) so
   nothing is silently dropped.
4. Slides with more than 7 bullets split into "(cont.)" slides.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from typing import Any

from lxml import etree
from markdown_it import MarkdownIt
from markdown_it.token import Token
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt

# ============================================================
# Theme system (shared vocabulary with the word extension)
# ============================================================


@dataclass(frozen=True)
class Theme:
    accent: str
    accent_light: str
    text_dark: str
    text_muted: str
    heading_font: str
    body_font: str
    mono_font: str


THEMES: dict[str, Theme] = {
    "executive": Theme(
        "1F3A5F", "D9E2F3", "1F2937", "6B7280", "Calibri Light", "Calibri", "Consolas"
    ),
    "modern": Theme("4F46E5", "E0E7FF", "111827", "6B7280", "Segoe UI", "Segoe UI", "Consolas"),
    "minimal": Theme("111827", "E5E7EB", "111827", "6B7280", "Arial", "Arial", "Consolas"),
    "editorial": Theme("7C2D12", "EFDFD3", "1F2937", "6B7280", "Georgia", "Georgia", "Consolas"),
    "tech": Theme("0F766E", "CCFBF1", "111827", "6B7280", "Segoe UI", "Calibri", "Consolas"),
}

BAND_FILL = "F5F7FA"
CODE_BG = "F3F4F6"

LAYOUTS = ["title", "section", "content", "two_column", "table", "quote", "image", "closing"]

# Slide geometry (inches, 16:9)
SLIDE_W = 13.333
SLIDE_H = 7.5
MARGIN = 0.7
CONTENT_W = SLIDE_W - 2 * MARGIN
CONTENT_TOP = 1.9
CONTENT_BOTTOM = 6.85
MAX_BULLETS_PER_SLIDE = 7

_MD_INLINE = MarkdownIt("commonmark").enable(["strikethrough"])


def _mix(hex_color: str, other: str, factor: float) -> str:
    """Blend hex_color toward other by factor (0..1)."""
    a = [int(hex_color[i : i + 2], 16) for i in (0, 2, 4)]
    b = [int(other[i : i + 2], 16) for i in (0, 2, 4)]
    return "".join(f"{round(x + (y - x) * factor):02X}" for x, y in zip(a, b))


# ============================================================
# Options
# ============================================================


@dataclass
class Options:
    theme_name: str
    theme: Theme
    title: str | None
    subtitle: str | None
    author: str | None
    date: str | None
    footer_text: str | None
    slide_numbers: bool
    output_path: str
    project_root: str


def _opt_str(spec: dict[str, Any], key: str) -> str | None:
    value = spec.get(key)
    if value is None or value == "":
        return None
    return str(value)


def _resolve_theme(spec: dict[str, Any]) -> tuple[str, Theme]:
    name = str(spec.get("theme") or "executive").lower()
    if name not in THEMES:
        raise ValueError(f"theme must be one of {list(THEMES)}, got {name!r}")
    theme = THEMES[name]
    accent = _opt_str(spec, "accent_color")
    if accent:
        accent = accent.lstrip("#").upper()
        if len(accent) != 6 or any(c not in "0123456789ABCDEF" for c in accent):
            raise ValueError(f"accent_color must be a 6-digit hex color, got {accent!r}")
        theme = Theme(
            accent,
            theme.accent_light,
            theme.text_dark,
            theme.text_muted,
            theme.heading_font,
            theme.body_font,
            theme.mono_font,
        )
    return name, theme


def parse_options(spec: dict[str, Any]) -> Options:
    theme_name, theme = _resolve_theme(spec)
    output_path = _opt_str(spec, "output_path")
    if not output_path:
        raise ValueError("output_path is required in the generator spec")
    return Options(
        theme_name=theme_name,
        theme=theme,
        title=_opt_str(spec, "title"),
        subtitle=_opt_str(spec, "subtitle"),
        author=_opt_str(spec, "author"),
        date=_opt_str(spec, "date"),
        footer_text=_opt_str(spec, "footer_text"),
        slide_numbers=bool(spec.get("slide_numbers", True)),
        output_path=output_path,
        project_root=_opt_str(spec, "project_root") or os.getcwd(),
    )


# ============================================================
# Slide normalization
# ============================================================


def _normalize_bullet(item: Any) -> dict[str, Any]:
    if isinstance(item, str):
        return {"text": item, "level": 0, "bold": False}
    if isinstance(item, dict) and "text" in item:
        level = int(item.get("level") or 0)
        return {
            "text": str(item["text"]),
            "level": max(0, min(level, 2)),
            "bold": bool(item.get("bold")),
        }
    raise ValueError(f"invalid bullet item: {item!r}")


def _normalize_column(column: Any) -> dict[str, Any]:
    if not isinstance(column, dict):
        return {"heading": None, "body": None, "bullets": []}
    return {
        "heading": column.get("heading"),
        "body": column.get("body"),
        "bullets": [_normalize_bullet(b) for b in column.get("bullets") or []],
    }


def normalize_slide(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError(f"slide must be an object, got {type(raw).__name__}")
    layout = str(raw.get("layout") or "content")
    if layout not in LAYOUTS:
        raise ValueError(f"layout must be one of {LAYOUTS}, got {layout!r}")
    slide = dict(raw)
    slide["layout"] = layout
    slide["bullets"] = [_normalize_bullet(b) for b in raw.get("bullets") or []]
    if layout == "two_column":
        slide["left"] = _normalize_column(raw.get("left"))
        slide["right"] = _normalize_column(raw.get("right"))
    return slide


# ============================================================
# Markdown -> slides
# ============================================================


def _plain(inline: Token) -> str:
    return "".join(
        child.content for child in (inline.children or []) if child.type in ("text", "code_inline")
    )


class _MarkdownSlicer:
    """Walks block tokens and accumulates slide dicts per the documented rules."""

    def __init__(self, meta: Options) -> None:
        self.meta = meta
        self.slides: list[dict[str, Any]] = []
        self.current: dict[str, Any] | None = None
        self.section_pending = False
        self.warnings: list[str] = []

    @staticmethod
    def _blank(title: str | None = None) -> dict[str, Any]:
        return {"title": title, "bullets": [], "body_parts": [], "images": [], "code_parts": []}

    def slice(self, tokens: list[Token]) -> list[dict[str, Any]]:
        i = self._maybe_title_slide(tokens)
        while i < len(tokens):
            i = self._consume(tokens, i)
        self._finalize()
        if not self.slides or self.slides[0]["layout"] != "title":
            if self.meta.title:
                self.slides.insert(0, {"layout": "title", "title": self.meta.title})
        return self.slides

    def _maybe_title_slide(self, tokens: list[Token]) -> int:
        if tokens and tokens[0].type == "heading_open" and tokens[0].tag == "h1":
            slide: dict[str, Any] = {"layout": "title", "title": _plain(tokens[1])}
            i = 3
            if i < len(tokens) and tokens[i].type == "paragraph_open":
                children = tokens[i + 1].children or []
                only_image = len(children) == 1 and children[0].type == "image"
                subtitle = _plain(tokens[i + 1])
                # An image-only (or empty) paragraph is not a subtitle — leave it
                # for the normal walk so it becomes an image slide.
                if subtitle and not only_image:
                    slide["subtitle"] = subtitle
                    i += 3
            self.slides.append(slide)
            return i
        return 0

    def _consume(self, tokens: list[Token], i: int) -> int:
        token = tokens[i]
        if token.type == "hr":
            self.section_pending = True
            return i + 1
        if token.type == "heading_open":
            return self._heading(tokens, i)
        self.section_pending = False
        if token.type == "paragraph_open":
            return self._paragraph(tokens, i)
        if token.type in ("bullet_list_open", "ordered_list_open"):
            return self._list(tokens, i, 0)
        if token.type == "blockquote_open":
            return self._blockquote(tokens, i)
        if token.type == "table_open":
            return self._table(tokens, i)
        if token.type in ("fence", "code_block"):
            self._slide()["code_parts"].append(token.content)
            return i + 1
        if token.type == "html_block":
            self.warnings.append("html block dropped (not supported on slides)")
        return i + 1

    def _slide(self) -> dict[str, Any]:
        if self.current is None:
            self.current = self._blank()
        return self.current

    def _heading(self, tokens: list[Token], i: int) -> int:
        level = int(tokens[i].tag[1])
        text = _plain(tokens[i + 1])
        # Any heading consumes a pending hr, so only an H2 IMMEDIATELY after the
        # hr becomes a section divider.
        pending, self.section_pending = self.section_pending, False
        if level <= 2:
            self._finalize()
            if pending and level == 2:
                self.slides.append({"layout": "section", "title": text})
            else:
                self.current = self._blank(text)
        else:
            self._slide()["bullets"].append({"text": text, "level": 0, "bold": True})
        return i + 3

    def _paragraph(self, tokens: list[Token], i: int) -> int:
        children = tokens[i + 1].children or []
        if len(children) == 1 and children[0].type == "image":
            self._slide()["images"].append(
                {
                    "path": str(children[0].attrs.get("src", "")),
                    "caption": children[0].content or None,
                }
            )
        else:
            self._slide()["body_parts"].append(tokens[i + 1].content)
        return i + 3

    def _list(self, tokens: list[Token], i: int, depth: int) -> int:
        close = tokens[i].type.replace("_open", "_close")
        i += 1
        while tokens[i].type != close:
            if tokens[i].type == "list_item_open":
                i = self._list_item(tokens, i, depth)
            else:
                i += 1
        return i + 1

    def _list_item(self, tokens: list[Token], i: int, depth: int) -> int:
        i += 1
        while tokens[i].type != "list_item_close":
            if tokens[i].type == "paragraph_open":
                self._slide()["bullets"].append(
                    {"text": tokens[i + 1].content, "level": min(depth, 2), "bold": False}
                )
                i += 3
            elif tokens[i].type in ("bullet_list_open", "ordered_list_open"):
                i = self._list(tokens, i, depth + 1)
            else:
                i += 1
        return i + 1

    def _blockquote(self, tokens: list[Token], i: int) -> int:
        parts: list[str] = []
        while tokens[i].type != "blockquote_close":
            if tokens[i].type == "inline":
                parts.append(tokens[i].content)
            i += 1
        text = "\n".join(parts).strip()
        attribution = None
        lines = text.split("\n")
        if len(lines) > 1 and lines[-1].lstrip().startswith(("—", "--")):
            attribution = lines[-1].lstrip().lstrip("—-").strip()
            text = "\n".join(lines[:-1]).strip()
        slide = self._slide()
        if "quote" not in slide and not slide["bullets"] and not slide["body_parts"]:
            slide["quote"] = text
            slide["attribution"] = attribution
        else:
            # A second quote (or a quote after other content) joins the body
            # instead of overwriting the slide's quote.
            self._slide()["body_parts"].append(text)
        return i + 1

    def _table(self, tokens: list[Token], i: int) -> int:
        headers: list[str] = []
        rows: list[list[str]] = []
        row: list[str] = []
        in_head = False
        while tokens[i].type != "table_close":
            if tokens[i].type == "thead_open":
                in_head = True
            elif tokens[i].type == "thead_close":
                in_head = False
            elif tokens[i].type == "tr_open":
                row = []
            elif tokens[i].type == "inline":
                row.append(tokens[i].content)
            elif tokens[i].type == "tr_close":
                if in_head:
                    headers = row
                else:
                    rows.append(row)
            i += 1
        self._slide()["table"] = {"headers": headers, "rows": rows}
        return i + 1

    def _finalize(self) -> None:
        slide = self.current
        self.current = None
        if slide is None:
            return
        for built in self._materialize(slide):
            self.slides.append(built)

    def _materialize(self, slide: dict[str, Any]) -> list[dict[str, Any]]:
        """Turn an accumulated chunk into pages without dropping any content.

        Order: quote page, then body/bullet/code content pages, then the table
        page (which renders the body itself when no content page consumed it),
        then one image page per collected image. The first emitted page carries
        the chunk's title.
        """
        title = slide.get("title")
        body = "\n\n".join(slide["body_parts"]) or None
        bullets = slide["bullets"]
        table = slide.get("table")
        code_parts = slide.get("code_parts") or []
        pages: list[dict[str, Any]] = []
        if slide.get("quote"):
            pages.append(
                {
                    "layout": "quote",
                    "title": title,
                    "quote": slide["quote"],
                    "attribution": slide.get("attribution"),
                }
            )
        body_on_table = table is not None and not bullets and not code_parts
        if bullets or code_parts or (body and not body_on_table):
            first_title = title if not pages else None
            pages.extend(
                self._content_pages(
                    first_title, bullets, None if body_on_table else body, code_parts
                )
            )
        if table is not None:
            pages.append(
                {
                    "layout": "table",
                    "title": title if not pages else None,
                    "table": table,
                    "body": body if body_on_table else None,
                }
            )
        for image in slide.get("images") or []:
            pages.append(
                {
                    "layout": "image",
                    "title": title if not pages else None,
                    "image_path": image["path"],
                    "caption": image["caption"],
                }
            )
        if not pages and title:
            pages.append({"layout": "content", "title": title, "bullets": [], "body": None})
        return pages

    def _content_pages(
        self,
        title: str | None,
        bullets: list[dict[str, Any]],
        body: str | None,
        code_parts: list[str],
    ) -> list[dict[str, Any]]:
        chunks = [
            bullets[j : j + MAX_BULLETS_PER_SLIDE]
            for j in range(0, len(bullets), MAX_BULLETS_PER_SLIDE)
        ] or [[]]
        pages: list[dict[str, Any]] = []
        for index, chunk in enumerate(chunks):
            page_title = title if index == 0 else f"{title} (cont.)" if title else None
            pages.append(
                {
                    "layout": "content",
                    "title": page_title,
                    "bullets": chunk,
                    "body": body if index == 0 else None,
                    "code": code_parts if index == 0 else [],
                }
            )
        return pages


def markdown_to_slides(markdown: str, meta: Options) -> tuple[list[dict[str, Any]], list[str]]:
    parser = MarkdownIt("commonmark").enable(["table", "strikethrough"])
    tokens = parser.parse(markdown)
    slicer = _MarkdownSlicer(meta)
    slides = [normalize_slide(s) for s in slicer.slice(tokens)]
    return slides, slicer.warnings


# ============================================================
# Text helpers
# ============================================================


def _add_md_runs(
    paragraph: Any,
    text: str,
    font: str,
    size_pt: float,
    color: str,
    mono_font: str,
    bold: bool = False,
    italic: bool = False,
) -> None:
    """Render inline markdown emphasis (**bold**, *italic*, `code`, ~~strike~~) as runs."""
    tokens = _MD_INLINE.parseInline(text)
    children = tokens[0].children if tokens else []
    state = {"bold": bold, "italic": italic, "strike": False}
    toggles = {
        "strong_open": ("bold", True),
        "strong_close": ("bold", bold),
        "em_open": ("italic", True),
        "em_close": ("italic", italic),
        "s_open": ("strike", True),
        "s_close": ("strike", False),
    }
    for token in children or []:
        if token.type in toggles:
            key, value = toggles[token.type]
            state[key] = value
        elif token.type in ("text", "softbreak"):
            content = " " if token.type == "softbreak" else token.content
            _add_run(paragraph, content, font, size_pt, color, state)
        elif token.type == "code_inline":
            _add_run(paragraph, token.content, mono_font, size_pt - 1, color, state)
        elif token.type == "link_open":
            continue


def _add_run(
    paragraph: Any, text: str, font: str, size_pt: float, color: str, state: dict[str, bool]
) -> None:
    run = paragraph.add_run()
    run.text = text
    run.font.name = font
    run.font.size = Pt(size_pt)
    run.font.color.rgb = RGBColor.from_string(color)
    run.font.bold = state["bold"]
    run.font.italic = state["italic"]
    if state["strike"]:
        run.font._rPr.set("strike", "sngStrike")


def _set_bullet_glyph(paragraph: Any, glyph: str, color: str, level: int) -> None:
    """Give a textbox paragraph a real DrawingML bullet with a hanging indent."""
    hang = 0.28
    ppr = paragraph._p.get_or_add_pPr()
    ppr.set("marL", str(int((hang + level * hang) * 914400)))
    ppr.set("indent", str(int(-hang * 914400)))
    bu_clr = etree.SubElement(ppr, qn("a:buClr"))
    etree.SubElement(bu_clr, qn("a:srgbClr"), {"val": color})
    etree.SubElement(ppr, qn("a:buFont"), {"typeface": "Arial"})
    etree.SubElement(ppr, qn("a:buChar"), {"char": glyph})


# ============================================================
# Slide builder
# ============================================================


class PptxBuilder:
    def __init__(self, opts: Options) -> None:
        self.opts = opts
        self.theme = opts.theme
        self.prs = Presentation()
        self.prs.slide_width = Inches(SLIDE_W)
        self.prs.slide_height = Inches(SLIDE_H)
        self.blank = self.prs.slide_layouts[6]
        self.warnings: list[str] = []
        self.layouts_used: dict[str, int] = {}
        self.section_index = 0

    # ---- shared primitives ----

    def _new_slide(self, layout: str) -> Any:
        self.layouts_used[layout] = self.layouts_used.get(layout, 0) + 1
        return self.prs.slides.add_slide(self.blank)

    def _rect(self, slide: Any, x: float, y: float, w: float, h: float, color: str) -> Any:
        shape = slide.shapes.add_shape(
            MSO_SHAPE.RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h)
        )
        shape.fill.solid()
        shape.fill.fore_color.rgb = RGBColor.from_string(color)
        shape.line.fill.background()
        shape.shadow.inherit = False
        return shape

    def _textbox(self, slide: Any, x: float, y: float, w: float, h: float) -> Any:
        box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
        box.text_frame.word_wrap = True
        box.text_frame.auto_size = MSO_AUTO_SIZE.NONE
        return box

    def _text(
        self,
        slide: Any,
        x: float,
        y: float,
        w: float,
        h: float,
        text: str,
        font: str,
        size_pt: float,
        color: str,
        bold: bool = False,
        italic: bool = False,
        align: Any = PP_ALIGN.LEFT,
        anchor: Any = MSO_ANCHOR.TOP,
    ) -> Any:
        box = self._textbox(slide, x, y, w, h)
        frame = box.text_frame
        frame.vertical_anchor = anchor
        paragraph = frame.paragraphs[0]
        paragraph.alignment = align
        _add_md_runs(paragraph, text, font, size_pt, color, self.theme.mono_font, bold, italic)
        return box

    def _footer(self, slide: Any, number: int) -> None:
        t = self.theme
        if self.opts.footer_text:
            self._text(
                slide, MARGIN, 7.08, 6.0, 0.3, self.opts.footer_text, t.body_font, 10, t.text_muted
            )
        if self.opts.slide_numbers:
            self._text(
                slide,
                SLIDE_W - MARGIN - 0.6,
                7.08,
                0.6,
                0.3,
                str(number),
                t.body_font,
                10,
                t.text_muted,
                align=PP_ALIGN.RIGHT,
            )

    def _content_header(self, slide: Any, title: str | None, kicker: str | None) -> None:
        t = self.theme
        if kicker:
            self._text(
                slide,
                MARGIN,
                0.52,
                CONTENT_W,
                0.32,
                kicker.upper(),
                t.body_font,
                11,
                t.accent,
                bold=True,
            )
        if title:
            self._text(
                slide,
                MARGIN,
                0.85,
                CONTENT_W,
                0.75,
                title,
                t.heading_font,
                24,
                t.text_dark,
                bold=True,
            )
            self._rect(slide, MARGIN, 1.68, 1.1, 0.045, t.accent)

    def _bullet_sizes(self, bullets: list[dict[str, Any]]) -> tuple[float, float, float]:
        lines = sum(1 + len(str(b["text"])) // 90 for b in bullets)
        if lines <= 9:
            return (16.0, 14.0, 12.5)
        if lines <= 12:
            return (14.0, 13.0, 12.0)
        return (13.0, 12.0, 11.0)

    def _bullets_into(
        self, frame: Any, bullets: list[dict[str, Any]], sizes: tuple[float, float, float]
    ) -> None:
        t = self.theme
        glyphs = [("•", t.accent), ("–", t.text_muted), ("·", t.text_muted)]
        first = True
        for bullet in bullets:
            paragraph = frame.paragraphs[0] if first else frame.add_paragraph()
            first = False
            level = int(bullet["level"])
            size = sizes[level]
            paragraph.space_after = Pt(max(4.0, size * 0.45))
            glyph, glyph_color = glyphs[level]
            _set_bullet_glyph(paragraph, glyph, glyph_color, level)
            color = t.text_dark if level == 0 else t.text_muted
            _add_md_runs(
                paragraph,
                str(bullet["text"]),
                t.body_font,
                size,
                color,
                t.mono_font,
                bold=bool(bullet.get("bold")),
            )

    def _notes(self, slide: Any, notes: str | None) -> None:
        if notes:
            slide.notes_slide.notes_text_frame.text = notes

    # ---- layouts ----

    def build(self, spec: dict[str, Any], number: int) -> None:
        layout = spec["layout"]
        builder = getattr(self, f"_build_{layout}")
        slide = builder(spec)
        if layout in ("content", "two_column", "table", "quote", "image"):
            self._footer(slide, number)
        self._notes(slide, spec.get("notes"))

    def _build_title(self, spec: dict[str, Any]) -> Any:
        t = self.theme
        slide = self._new_slide("title")
        self._rect(slide, MARGIN, 2.35, 1.6, 0.055, t.accent)
        self._text(
            slide,
            MARGIN,
            2.55,
            11.0,
            1.7,
            spec.get("title") or "Presentation",
            t.heading_font,
            40,
            t.text_dark,
            bold=True,
        )
        subtitle = spec.get("subtitle") or self.opts.subtitle
        if subtitle:
            self._text(slide, MARGIN, 4.2, 10.5, 0.9, subtitle, t.body_font, 18, t.text_muted)
        meta = "  ·  ".join(
            p
            for p in (spec.get("author") or self.opts.author, spec.get("date") or self.opts.date)
            if p
        )
        if meta:
            self._text(slide, MARGIN, 6.35, 10.0, 0.45, meta, t.body_font, 12, t.text_muted)
        self._rect(slide, 11.6, 5.9, 1.05, 1.05, t.accent_light)
        self._rect(slide, 12.15, 6.45, 0.5, 0.5, t.accent)
        return slide

    def _build_section(self, spec: dict[str, Any]) -> Any:
        t = self.theme
        slide = self._new_slide("section")
        self.section_index += 1
        self._rect(slide, 0, 0, SLIDE_W, SLIDE_H, t.accent)
        self._text(
            slide,
            10.4,
            0.45,
            2.4,
            1.7,
            f"{self.section_index:02d}",
            t.heading_font,
            96,
            _mix(t.accent, "FFFFFF", 0.25),
            bold=True,
            align=PP_ALIGN.RIGHT,
        )
        self._rect(slide, MARGIN, 2.95, 1.2, 0.055, "FFFFFF")
        self._text(
            slide,
            MARGIN,
            3.15,
            11.9,
            1.6,
            spec.get("title") or "",
            t.heading_font,
            32,
            "FFFFFF",
            bold=True,
        )
        return slide

    def _build_content(self, spec: dict[str, Any]) -> Any:
        slide = self._new_slide("content")
        self._content_header(slide, spec.get("title"), spec.get("kicker"))
        y = CONTENT_TOP
        body = spec.get("body")
        if body:
            y = self._body_text(slide, y, str(body), cap=3.2)
        for code in spec.get("code") or []:
            y = self._code_panel(slide, y, str(code))
        bullets = spec.get("bullets") or []
        if bullets:
            height = CONTENT_BOTTOM - y
            if height < 0.5:
                self.warnings.append("content slide overflows; bullet area clamped")
                y = CONTENT_BOTTOM - 0.5
                height = 0.5
            box = self._textbox(slide, MARGIN, y, CONTENT_W, height)
            self._bullets_into(box.text_frame, bullets, self._bullet_sizes(bullets))
        return slide

    def _body_text(self, slide: Any, y: float, body: str, cap: float) -> float:
        """Render body paragraphs at y; returns the next y (advance capped)."""
        t = self.theme
        box = self._text(slide, MARGIN, y, CONTENT_W, 1.2, body, t.body_font, 14, t.text_dark)
        for paragraph in box.text_frame.paragraphs:
            paragraph.space_after = Pt(8)
        advance = 0.45 + 0.28 * body.count("\n")
        if advance > cap:
            self.warnings.append("body text is long; following content clamped and may overlap")
            advance = cap
        return y + advance

    def _code_panel(self, slide: Any, y: float, code: str) -> float:
        """Render a fenced code block as a shaded monospace panel; returns the next y."""
        t = self.theme
        lines = code.rstrip("\n").split("\n")
        if len(lines) > 12:
            self.warnings.append(f"code block truncated to 12 of {len(lines)} lines")
            lines = lines[:12]
        height = 0.3 + 0.24 * len(lines)
        if y + height > CONTENT_BOTTOM:
            self.warnings.append("code block clamped to fit slide")
            height = max(CONTENT_BOTTOM - y, 0.5)
        self._rect(slide, MARGIN, y, CONTENT_W, height, CODE_BG)
        box = self._textbox(slide, MARGIN + 0.15, y + 0.1, CONTENT_W - 0.3, max(height - 0.2, 0.2))
        first = True
        for line in lines:
            paragraph = box.text_frame.paragraphs[0] if first else box.text_frame.add_paragraph()
            first = False
            run = paragraph.add_run()
            run.text = line or " "
            run.font.name = t.mono_font
            run.font.size = Pt(12)
            run.font.color.rgb = RGBColor.from_string(t.text_dark)
        return y + height + 0.15

    def _build_two_column(self, spec: dict[str, Any]) -> Any:
        t = self.theme
        slide = self._new_slide("two_column")
        self._content_header(slide, spec.get("title"), spec.get("kicker"))
        column_w = (CONTENT_W - 0.6) / 2
        for index, side in enumerate(("left", "right")):
            column = spec.get(side) or {}
            x = MARGIN + index * (column_w + 0.6)
            y = CONTENT_TOP
            if column.get("heading"):
                self._text(
                    slide,
                    x,
                    y,
                    column_w,
                    0.4,
                    str(column["heading"]),
                    t.body_font,
                    15,
                    t.accent,
                    bold=True,
                )
                y += 0.5
            if column.get("body"):
                self._text(
                    slide, x, y, column_w, 1.0, str(column["body"]), t.body_font, 13, t.text_dark
                )
                y += 0.6
            bullets = column.get("bullets") or []
            if bullets:
                box = self._textbox(slide, x, y, column_w, CONTENT_BOTTOM - y)
                self._bullets_into(box.text_frame, bullets, (13.0, 12.0, 11.0))
        return slide

    def _build_table(self, spec: dict[str, Any]) -> Any:
        slide = self._new_slide("table")
        self._content_header(slide, spec.get("title"), spec.get("kicker"))
        y = CONTENT_TOP
        body = spec.get("body")
        if body:
            y = self._body_text(slide, y, str(body), cap=2.0)
        table_spec = spec.get("table") or {}
        headers = [str(h) for h in table_spec.get("headers") or []]
        rows = [[str(c) for c in row] for row in table_spec.get("rows") or []]
        cap = max(1, min(10, int((CONTENT_BOTTOM - y - 0.5) / 0.42)))
        if len(rows) > cap:
            self.warnings.append(f"table truncated to {cap} of {len(rows)} rows")
            rows = rows[:cap]
        cols = max(len(headers), max((len(r) for r in rows), default=0), 1)
        shape = slide.shapes.add_table(
            len(rows) + 1,
            cols,
            Inches(MARGIN),
            Inches(y),
            Inches(CONTENT_W),
            Inches(0.5 + 0.42 * len(rows)),
        )
        self._style_table(shape.table, headers, rows, cols)
        return slide

    def _style_table(
        self, table: Any, headers: list[str], rows: list[list[str]], cols: int
    ) -> None:
        t = self.theme
        table.first_row = False
        table.horz_banding = False
        table.rows[0].height = Inches(0.5)
        for index in range(len(rows)):
            table.rows[index + 1].height = Inches(0.42)
        for c in range(cols):
            header = headers[c] if c < len(headers) else ""
            self._style_cell(table.cell(0, c), header, t.accent, "FFFFFF", 13, bold=True)
            for r, row in enumerate(rows):
                fill = BAND_FILL if r % 2 == 1 else "FFFFFF"
                value = row[c] if c < len(row) else ""
                self._style_cell(table.cell(r + 1, c), value, fill, t.text_dark, 12)

    def _style_cell(
        self, cell: Any, text: str, fill: str, color: str, size_pt: float, bold: bool = False
    ) -> None:
        t = self.theme
        cell.fill.solid()
        cell.fill.fore_color.rgb = RGBColor.from_string(fill)
        cell.margin_left = Inches(0.12)
        cell.margin_right = Inches(0.12)
        cell.vertical_anchor = MSO_ANCHOR.MIDDLE
        paragraph = cell.text_frame.paragraphs[0]
        _add_md_runs(paragraph, text, t.body_font, size_pt, color, t.mono_font, bold=bold)

    def _build_quote(self, spec: dict[str, Any]) -> Any:
        t = self.theme
        slide = self._new_slide("quote")
        has_header = bool(spec.get("title") or spec.get("kicker"))
        if has_header:
            self._content_header(slide, spec.get("title"), spec.get("kicker"))
        glyph_y, quote_y, attr_y = (1.85, 3.0, 5.6) if has_header else (0.55, 2.45, 5.35)
        self._text(
            slide, 0.9, glyph_y, 2.2, 2.0, "“", t.heading_font, 120, t.accent_light, bold=True
        )
        self._text(
            slide,
            2.17,
            quote_y,
            9.0,
            2.4,
            str(spec.get("quote") or ""),
            t.heading_font,
            24,
            t.text_dark,
            italic=True,
            align=PP_ALIGN.CENTER,
            anchor=MSO_ANCHOR.MIDDLE,
        )
        if spec.get("attribution"):
            self._text(
                slide,
                2.17,
                attr_y,
                9.0,
                0.5,
                f"— {spec['attribution']}",
                t.body_font,
                14,
                t.text_muted,
                align=PP_ALIGN.CENTER,
            )
        return slide

    def _build_image(self, spec: dict[str, Any]) -> Any:
        t = self.theme
        slide = self._new_slide("image")
        self._content_header(slide, spec.get("title"), spec.get("kicker"))
        src = str(spec.get("image_path") or "")
        path = src if os.path.isabs(src) else os.path.join(self.opts.project_root, src)
        caption = spec.get("caption")
        top = CONTENT_TOP if spec.get("title") else 0.9
        bottom = 6.45 if caption else CONTENT_BOTTOM
        if not os.path.isfile(path):
            self.warnings.append(f"image not found: {src}")
            self._text(
                slide,
                MARGIN,
                3.2,
                CONTENT_W,
                0.6,
                f"[image unavailable: {caption or src}]",
                t.body_font,
                14,
                t.text_muted,
                align=PP_ALIGN.CENTER,
            )
            return slide
        width, height = self._fit_image(path, CONTENT_W, bottom - top)
        slide.shapes.add_picture(
            path,
            Inches(MARGIN + (CONTENT_W - width) / 2),
            Inches(top + (bottom - top - height) / 2),
            Inches(width),
            Inches(height),
        )
        if caption:
            self._text(
                slide,
                MARGIN,
                6.55,
                CONTENT_W,
                0.4,
                str(caption),
                t.body_font,
                11,
                t.text_muted,
                align=PP_ALIGN.CENTER,
            )
        return slide

    def _fit_image(self, path: str, max_w: float, max_h: float) -> tuple[float, float]:
        try:
            from PIL import Image

            with Image.open(path) as img:
                ratio = img.width / img.height
        except Exception:
            ratio = 4 / 3
        width = min(max_w, max_h * ratio)
        return width, width / ratio

    def _build_closing(self, spec: dict[str, Any]) -> Any:
        t = self.theme
        slide = self._new_slide("closing")
        self._rect(slide, 0, 0, SLIDE_W, SLIDE_H, t.accent)
        self._text(
            slide,
            1.17,
            2.9,
            11.0,
            1.2,
            spec.get("title") or "Thank you",
            t.heading_font,
            32,
            "FFFFFF",
            bold=True,
            align=PP_ALIGN.CENTER,
        )
        subtitle = spec.get("subtitle")
        if subtitle:
            self._text(
                slide,
                1.17,
                4.15,
                11.0,
                0.8,
                str(subtitle),
                t.body_font,
                16,
                t.accent_light,
                align=PP_ALIGN.CENTER,
            )
        return slide


# ============================================================
# Entry point
# ============================================================


def _load_slides(spec: dict[str, Any], opts: Options) -> tuple[list[dict[str, Any]], list[str]]:
    slides = spec.get("slides")
    markdown = spec.get("markdown")
    # Whitespace-only markdown counts as absent, matching the TS-side gate.
    has_markdown = bool(markdown and str(markdown).strip())
    if slides and has_markdown:
        raise ValueError("provide exactly one of 'slides' or 'markdown', not both")
    if slides:
        if not isinstance(slides, list):
            raise ValueError("'slides' must be a non-empty array")
        return [normalize_slide(s) for s in slides], []
    if has_markdown:
        result, warnings = markdown_to_slides(str(markdown), opts)
        if not result:
            raise ValueError("markdown produced no slides")
        return result, warnings
    raise ValueError("spec requires 'slides' or non-empty 'markdown'")


def generate(spec: dict[str, Any]) -> dict[str, Any]:
    opts = parse_options(spec)
    slides, md_warnings = _load_slides(spec, opts)
    builder = PptxBuilder(opts)
    builder.warnings.extend(md_warnings)
    for number, slide_spec in enumerate(slides, start=1):
        builder.build(slide_spec, number)
    os.makedirs(os.path.dirname(opts.output_path) or ".", exist_ok=True)
    builder.prs.save(opts.output_path)
    return {
        "path": os.path.abspath(opts.output_path),
        "slide_count": len(slides),
        "layouts_used": builder.layouts_used,
        "theme": opts.theme_name,
        "warnings": builder.warnings,
    }


def main() -> None:
    spec = json.loads(sys.stdin.read())
    result = generate(spec)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — single stderr contract with the TS caller
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
