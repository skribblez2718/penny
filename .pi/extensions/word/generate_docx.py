#!/usr/bin/env python3
"""Generate a professionally styled Word (.docx) document from markdown.

Reads a JSON spec from stdin, renders the markdown through python-docx with a
themed design system, writes the document, and prints a JSON result to stdout.
Called by the word extension's word_generate tool.

Design choices:
- Markdown is parsed with markdown-it-py (CommonMark + tables + strikethrough),
  never regexes, so nesting and inline emphasis are handled correctly.
- Ordered lists are numbered manually with hanging indents instead of Word's
  "List Number" style, which never restarts across separate lists.
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.opc.constants import RELATIONSHIP_TYPE
from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Inches, Pt, RGBColor
from markdown_it import MarkdownIt
from markdown_it.token import Token

# ============================================================
# Theme system (shared vocabulary with the powerpoint extension)
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

NEUTRAL_BORDER = "D1D5DB"
CODE_BG = "F3F4F6"
BAND_FILL = "F5F7FA"

_HEX_RE = re.compile(r"^[0-9A-Fa-f]{6}$")

PAGE_SIZES: dict[str, tuple[float, float]] = {
    "letter": (8.5, 11.0),
    "a4": (8.27, 11.69),
}


# ============================================================
# Options
# ============================================================


@dataclass
class Options:
    title: str | None
    subtitle: str | None
    author: str | None
    date: str | None
    theme_name: str
    theme: Theme
    font_size_pt: float
    line_spacing: float
    margin_inches: float
    orientation: str
    page_size: str
    cover_page: bool
    include_toc: bool
    include_page_numbers: bool
    header_text: str | None
    footer_text: str | None
    table_style: str
    output_path: str
    project_root: str

    @property
    def content_width_in(self) -> float:
        w, h = PAGE_SIZES[self.page_size]
        page_w = h if self.orientation == "landscape" else w
        return page_w - 2 * self.margin_inches


def _opt_str(spec: dict[str, Any], key: str) -> str | None:
    value = spec.get(key)
    if value is None or value == "":
        return None
    return str(value)


def _enum(spec: dict[str, Any], key: str, allowed: list[str], default: str) -> str:
    value = str(spec.get(key) or default).lower()
    if value not in allowed:
        raise ValueError(f"{key} must be one of {allowed}, got {value!r}")
    return value


def _number(spec: dict[str, Any], key: str, default: float, lo: float, hi: float) -> float:
    value = float(spec.get(key) or default)
    if not lo <= value <= hi:
        raise ValueError(f"{key} must be between {lo} and {hi}, got {value}")
    return value


def _resolve_theme(spec: dict[str, Any]) -> tuple[str, Theme]:
    name = _enum(spec, "theme", list(THEMES.keys()), "executive")
    theme = THEMES[name]
    accent = _opt_str(spec, "accent_color")
    if accent:
        accent = accent.lstrip("#").upper()
        if not _HEX_RE.match(accent):
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
    author = _opt_str(spec, "author")
    cover_page = bool(spec.get("cover_page", False))
    date = _opt_str(spec, "date")
    if date is None and (author or cover_page):
        date = datetime.now().strftime("%Y-%m-%d")
    output_path = _opt_str(spec, "output_path")
    if not output_path:
        raise ValueError("output_path is required in the generator spec")
    return Options(
        title=_opt_str(spec, "title"),
        subtitle=_opt_str(spec, "subtitle"),
        author=author,
        date=date,
        theme_name=theme_name,
        theme=theme,
        font_size_pt=_number(spec, "font_size_pt", 11.0, 8.0, 14.0),
        line_spacing=_number(spec, "line_spacing", 1.15, 1.0, 2.0),
        margin_inches=_number(spec, "margin_inches", 1.0, 0.4, 2.0),
        orientation=_enum(spec, "orientation", ["portrait", "landscape"], "portrait"),
        page_size=_enum(spec, "page_size", ["letter", "a4"], "letter"),
        cover_page=cover_page,
        include_toc=bool(spec.get("include_toc", False)),
        include_page_numbers=bool(spec.get("include_page_numbers", True)),
        header_text=_opt_str(spec, "header_text"),
        footer_text=_opt_str(spec, "footer_text"),
        table_style=_enum(spec, "table_style", ["banded", "minimal", "grid", "none"], "banded"),
        output_path=output_path,
        project_root=_opt_str(spec, "project_root") or os.getcwd(),
    )


# ============================================================
# Low-level docx helpers
# ============================================================


def _rgb(hex_color: str) -> RGBColor:
    return RGBColor.from_string(hex_color)


def _set_run_font(
    run: Any,
    name: str | None = None,
    size_pt: float | None = None,
    color: str | None = None,
) -> None:
    if name:
        run.font.name = name
        rpr = run._element.get_or_add_rPr()
        rfonts = rpr.find(qn("w:rFonts"))
        if rfonts is None:
            rfonts = parse_xml(f'<w:rFonts {nsdecls("w")}/>')
            rpr.insert(0, rfonts)
        rfonts.set(qn("w:eastAsia"), name)
    if size_pt is not None:
        run.font.size = Pt(size_pt)
    if color:
        run.font.color.rgb = _rgb(color)


def _shade_paragraph(paragraph: Any, fill: str) -> None:
    ppr = paragraph._p.get_or_add_pPr()
    ppr.append(parse_xml(f'<w:shd {nsdecls("w")} w:val="clear" w:fill="{fill}"/>'))


def _shade_run(run: Any, fill: str) -> None:
    rpr = run._element.get_or_add_rPr()
    rpr.append(parse_xml(f'<w:shd {nsdecls("w")} w:val="clear" w:fill="{fill}"/>'))


def _paragraph_borders(paragraph: Any, edges: dict[str, tuple[str, int]]) -> None:
    """Apply borders to a paragraph. edges maps edge name -> (hex color, size in 1/8 pt)."""
    parts = "".join(
        f'<w:{edge} w:val="single" w:sz="{size}" w:space="4" w:color="{color}"/>'
        for edge, (color, size) in edges.items()
    )
    ppr = paragraph._p.get_or_add_pPr()
    ppr.append(parse_xml(f'<w:pBdr {nsdecls("w")}>{parts}</w:pBdr>'))


def _add_field(paragraph: Any, instruction: str, placeholder: str | None = None) -> None:
    """Insert a Word field code (e.g. PAGE, TOC) into a paragraph."""
    begin = paragraph.add_run()
    begin._element.append(parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="begin"/>'))
    instr = paragraph.add_run()
    instr._element.append(
        parse_xml(f'<w:instrText {nsdecls("w")} xml:space="preserve"> {instruction} </w:instrText>')
    )
    if placeholder is not None:
        sep = paragraph.add_run()
        sep._element.append(parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="separate"/>'))
        text = paragraph.add_run(placeholder)
        text.italic = True
        _set_run_font(text, size_pt=10, color="808080")
    end = paragraph.add_run()
    end._element.append(parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="end"/>'))


def _add_hyperlink_container(paragraph: Any, url: str) -> Any:
    """Create a real w:hyperlink element in the paragraph; caller moves runs into it."""
    r_id = paragraph.part.relate_to(url, RELATIONSHIP_TYPE.HYPERLINK, is_external=True)
    hyperlink = parse_xml(f'<w:hyperlink {nsdecls("w", "r")} r:id="{r_id}"/>')
    paragraph._p.append(hyperlink)
    return hyperlink


def _set_cell_fill(cell: Any, fill: str) -> None:
    tcpr = cell._tc.get_or_add_tcPr()
    tcpr.append(parse_xml(f'<w:shd {nsdecls("w")} w:val="clear" w:fill="{fill}"/>'))


def _set_cell_border_bottom(cell: Any, color: str, size: int) -> None:
    tcpr = cell._tc.get_or_add_tcPr()
    tcpr.append(
        parse_xml(
            f'<w:tcBorders {nsdecls("w")}>'
            f'<w:bottom w:val="single" w:sz="{size}" w:space="0" w:color="{color}"/>'
            f"</w:tcBorders>"
        )
    )


def _set_table_borders(table: Any, edges: dict[str, tuple[str, int]]) -> None:
    parts = "".join(
        f'<w:{edge} w:val="single" w:sz="{size}" w:space="0" w:color="{color}"/>'
        for edge, (color, size) in edges.items()
    )
    table._tbl.tblPr.append(parse_xml(f"<w:tblBorders {nsdecls('w')}>{parts}</w:tblBorders>"))


def _set_table_cell_margins(table: Any) -> None:
    table._tbl.tblPr.append(
        parse_xml(
            f'<w:tblCellMar {nsdecls("w")}>'
            f'<w:top w:w="80" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/>'
            f'<w:start w:w="110" w:type="dxa"/><w:end w:w="110" w:type="dxa"/>'
            f"</w:tblCellMar>"
        )
    )


def _style(doc: Any, name: str, fallback: str = "Normal") -> str:
    """Return a style name that exists in the document, falling back gracefully."""
    try:
        doc.styles[name]
        return name
    except KeyError:
        return fallback


# ============================================================
# Inline rendering (runs within a paragraph)
# ============================================================


@dataclass
class RunProfile:
    """Default run formatting for a rendering context (body, heading, quote, cell)."""

    font: str | None
    size_pt: float | None
    color: str | None
    mono_font: str
    accent: str
    italic: bool = False


@dataclass
class _InlineState:
    bold: bool = False
    italic: bool = False
    strike: bool = False
    link: Any = None  # active w:hyperlink element or None


_INLINE_TOGGLES: dict[str, tuple[str, bool]] = {
    "strong_open": ("bold", True),
    "strong_close": ("bold", False),
    "em_open": ("italic", True),
    "em_close": ("italic", False),
    "s_open": ("strike", True),
    "s_close": ("strike", False),
}


class InlineRenderer:
    """Renders markdown-it inline token children into docx runs."""

    def __init__(self, profile: RunProfile) -> None:
        self.profile = profile
        self.images: list[tuple[str, str]] = []

    def render(self, paragraph: Any, children: list[Token]) -> list[tuple[str, str]]:
        state = _InlineState()
        for token in children:
            self._render_token(paragraph, token, state)
        return self.images

    def _render_token(self, paragraph: Any, token: Token, state: _InlineState) -> None:
        toggle = _INLINE_TOGGLES.get(token.type)
        if toggle is not None:
            setattr(state, toggle[0], toggle[1])
        elif token.type == "text":
            self._emit(paragraph, token.content, state)
        elif token.type == "code_inline":
            self._emit(paragraph, token.content, state, mono=True)
        elif token.type == "link_open":
            state.link = _add_hyperlink_container(paragraph, str(token.attrs.get("href", "")))
        elif token.type == "link_close":
            state.link = None
        elif token.type == "softbreak":
            self._emit(paragraph, " ", state)
        elif token.type == "hardbreak":
            paragraph.add_run().add_break()
        elif token.type == "image":
            alt = token.content or str(token.attrs.get("alt", ""))
            self.images.append((str(token.attrs.get("src", "")), alt))

    def _emit(self, paragraph: Any, text: str, state: _InlineState, mono: bool = False) -> None:
        run = paragraph.add_run(text)
        run.bold = state.bold or None
        run.italic = state.italic or self.profile.italic or None
        run.font.strike = state.strike or None
        if mono:
            size = (self.profile.size_pt or 11.0) - 0.5
            _set_run_font(run, self.profile.mono_font, size, self.profile.color)
            _shade_run(run, CODE_BG)
        else:
            _set_run_font(run, self.profile.font, self.profile.size_pt, self.profile.color)
        if state.link is not None:
            run.font.color.rgb = _rgb(self.profile.accent)
            run.underline = True
            state.link.append(run._element)


# ============================================================
# Block rendering
# ============================================================

_BULLET_STYLES = ["List Bullet", "List Bullet 2", "List Bullet 3"]


class DocxRenderer:
    """Walks the markdown-it block token stream and emits styled docx content."""

    def __init__(self, doc: Any, opts: Options) -> None:
        self.doc = doc
        self.opts = opts
        self.theme = opts.theme
        self.warnings: list[str] = []
        self.stats = {"headings": 0, "tables": 0, "code_blocks": 0, "images": 0}

    # ---- profiles ----

    def _body_profile(self) -> RunProfile:
        t = self.theme
        return RunProfile(t.body_font, self.opts.font_size_pt, t.text_dark, t.mono_font, t.accent)

    def _heading_profile(self) -> RunProfile:
        t = self.theme
        return RunProfile(None, None, None, t.mono_font, t.accent)

    # ---- top-level walk ----

    def render(self, tokens: list[Token]) -> None:
        i = 0
        while i < len(tokens):
            i = self._render_block(tokens, i)

    def _render_block(self, tokens: list[Token], i: int) -> int:
        token = tokens[i]
        if token.type == "heading_open":
            return self._render_heading(tokens, i)
        if token.type == "paragraph_open":
            return self._render_paragraph(tokens, i, self._body_profile())
        if token.type in ("bullet_list_open", "ordered_list_open"):
            return self._render_list(tokens, i, 0)
        if token.type == "blockquote_open":
            return self._render_blockquote(tokens, i)
        if token.type in ("fence", "code_block"):
            self._render_code(token)
            return i + 1
        if token.type == "hr":
            self._render_hr()
            return i + 1
        if token.type == "table_open":
            return self._render_table(tokens, i)
        return i + 1

    # ---- blocks ----

    def _render_heading(self, tokens: list[Token], i: int) -> int:
        level = int(tokens[i].tag[1])
        inline = tokens[i + 1]
        paragraph = self.doc.add_paragraph(style=_style(self.doc, f"Heading {min(level, 6)}"))
        InlineRenderer(self._heading_profile()).render(paragraph, inline.children or [])
        if level == 1:
            _paragraph_borders(paragraph, {"bottom": (self.theme.accent_light, 6)})
        self.stats["headings"] += 1
        return i + 3

    def _render_paragraph(self, tokens: list[Token], i: int, profile: RunProfile) -> int:
        inline = tokens[i + 1]
        children = inline.children or []
        only_image = len(children) == 1 and children[0].type == "image"
        if only_image:
            self._render_image(
                str(children[0].attrs.get("src", "")),
                children[0].content or str(children[0].attrs.get("alt", "")),
            )
            return i + 3
        paragraph = self.doc.add_paragraph()
        images = InlineRenderer(profile).render(paragraph, children)
        for src, alt in images:
            self._render_image(src, alt)
        return i + 3

    def _render_list(self, tokens: list[Token], i: int, depth: int) -> int:
        ordered = tokens[i].type == "ordered_list_open"
        close = tokens[i].type.replace("_open", "_close")
        number = int(str(tokens[i].attrs.get("start", 1) or 1))
        i += 1
        while tokens[i].type != close:
            if tokens[i].type == "list_item_open":
                i = self._render_list_item(tokens, i, depth, number if ordered else None)
                number += 1
            else:
                i += 1
        return i + 1

    def _render_list_item(self, tokens: list[Token], i: int, depth: int, number: int | None) -> int:
        i += 1  # past list_item_open
        while tokens[i].type != "list_item_close":
            if tokens[i].type == "paragraph_open":
                i = self._render_list_paragraph(tokens, i, depth, number)
                number = None  # only the first paragraph carries the marker
            elif tokens[i].type in ("bullet_list_open", "ordered_list_open"):
                i = self._render_list(tokens, i, min(depth + 1, 2))
            else:
                # Fences, headings, tables, blockquotes inside a list item render
                # through the normal block dispatcher instead of being dropped.
                i = self._render_block(tokens, i)
        return i + 1

    def _render_list_paragraph(
        self, tokens: list[Token], i: int, depth: int, number: int | None
    ) -> int:
        if number is None:
            paragraph = self.doc.add_paragraph(style=_style(self.doc, _BULLET_STYLES[depth]))
        else:
            # Manual numbering with a hanging indent: Word's List Number style never
            # restarts across separate lists, so literal numbers are more correct.
            paragraph = self.doc.add_paragraph()
            fmt = paragraph.paragraph_format
            left = 0.25 * depth + 0.25
            fmt.left_indent = Inches(left)
            fmt.first_line_indent = Inches(-0.25)
            fmt.tab_stops.add_tab_stop(Inches(left), WD_TAB_ALIGNMENT.LEFT)
            marker = paragraph.add_run(f"{number}.\t")
            _set_run_font(
                marker, self.theme.body_font, self.opts.font_size_pt, self.theme.text_dark
            )
        paragraph.paragraph_format.space_after = Pt(2)
        images = InlineRenderer(self._body_profile()).render(
            paragraph, tokens[i + 1].children or []
        )
        for src, alt in images:
            self._render_image(src, alt)
        return i + 3

    def _render_blockquote(self, tokens: list[Token], i: int) -> int:
        t = self.theme
        profile = RunProfile(
            t.body_font, self.opts.font_size_pt, t.text_muted, t.mono_font, t.accent, italic=True
        )
        i += 1
        first = True
        while tokens[i].type != "blockquote_close":
            if tokens[i].type == "paragraph_open":
                paragraph_index = len(self.doc.paragraphs)
                i = self._render_paragraph(tokens, i, profile)
                for paragraph in self.doc.paragraphs[paragraph_index:]:
                    fmt = paragraph.paragraph_format
                    fmt.left_indent = Inches(0.25)
                    fmt.space_before = Pt(6 if first else 2)
                    fmt.space_after = Pt(2)
                    _paragraph_borders(paragraph, {"left": (t.accent, 18)})
                    first = False
            else:
                i = self._render_block(tokens, i)
        if self.doc.paragraphs:
            self.doc.paragraphs[-1].paragraph_format.space_after = Pt(6)
        return i + 1

    def _render_code(self, token: Token) -> None:
        lines = token.content.rstrip("\n").split("\n")
        t = self.theme
        for index, line in enumerate(lines):
            paragraph = self.doc.add_paragraph()
            fmt = paragraph.paragraph_format
            fmt.left_indent = Inches(0.15)
            fmt.right_indent = Inches(0.15)
            fmt.line_spacing = 1.0
            fmt.space_before = Pt(6) if index == 0 else Pt(0)
            fmt.space_after = Pt(6) if index == len(lines) - 1 else Pt(0)
            run = paragraph.add_run(line)
            _set_run_font(run, t.mono_font, 9.0, t.text_dark)
            _shade_paragraph(paragraph, CODE_BG)
            # Identical box borders on consecutive paragraphs merge into one frame.
            _paragraph_borders(
                paragraph,
                {
                    "top": (NEUTRAL_BORDER, 4),
                    "bottom": (NEUTRAL_BORDER, 4),
                    "left": (NEUTRAL_BORDER, 4),
                    "right": (NEUTRAL_BORDER, 4),
                },
            )
        self.stats["code_blocks"] += 1

    def _render_hr(self) -> None:
        paragraph = self.doc.add_paragraph()
        fmt = paragraph.paragraph_format
        fmt.space_before = Pt(10)
        fmt.space_after = Pt(10)
        _paragraph_borders(paragraph, {"bottom": (NEUTRAL_BORDER, 4)})

    def _render_image(self, src: str, alt: str) -> None:
        path = src if os.path.isabs(src) else os.path.join(self.opts.project_root, src)
        if not os.path.isfile(path):
            self.warnings.append(f"image not found: {src}")
            paragraph = self.doc.add_paragraph()
            paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
            run = paragraph.add_run(f"[image unavailable: {alt or src}]")
            _set_run_font(run, self.theme.body_font, 9.0, self.theme.text_muted)
            return
        width = self._image_width_inches(path)
        paragraph = self.doc.add_paragraph()
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        paragraph.add_run().add_picture(path, width=Inches(width))
        if alt:
            caption = self.doc.add_paragraph()
            caption.alignment = WD_ALIGN_PARAGRAPH.CENTER
            caption.paragraph_format.space_after = Pt(8)
            run = caption.add_run(alt)
            _set_run_font(run, self.theme.body_font, 9.0, self.theme.text_muted)
        self.stats["images"] += 1

    def _image_width_inches(self, path: str) -> float:
        max_width = self.opts.content_width_in
        try:
            from PIL import Image

            with Image.open(path) as img:
                natural = img.width / 96.0  # assume 96 dpi
            return min(natural, max_width)
        except Exception:
            return max_width

    # ---- tables ----

    def _render_table(self, tokens: list[Token], i: int) -> int:
        rows: list[tuple[list[list[Token]], bool]] = []
        while tokens[i].type != "table_close":
            if tokens[i].type == "tr_open":
                i, cells, is_header = self._collect_row(tokens, i)
                rows.append((cells, is_header))
            else:
                i += 1
        self._emit_table(rows)
        self.stats["tables"] += 1
        return i + 1

    def _collect_row(self, tokens: list[Token], i: int) -> tuple[int, list[list[Token]], bool]:
        cells: list[list[Token]] = []
        is_header = False
        i += 1
        while tokens[i].type != "tr_close":
            if tokens[i].type in ("th_open", "td_open"):
                is_header = is_header or tokens[i].type == "th_open"
                cells.append(tokens[i + 1].children or [])
                i += 3
            else:
                i += 1
        return i + 1, cells, is_header

    def _emit_table(self, rows: list[tuple[list[list[Token]], bool]]) -> None:
        if not rows:
            return
        cols = max(len(cells) for cells, _ in rows)
        table = self.doc.add_table(rows=len(rows), cols=cols)
        table.autofit = False
        _set_table_cell_margins(table)
        self._apply_table_borders(table)
        col_width = Inches(self.opts.content_width_in / cols)
        for r, (cells, is_header) in enumerate(rows):
            band = self.opts.table_style == "banded" and not is_header and r % 2 == 0
            for c in range(cols):
                cell = table.cell(r, c)
                cell.width = col_width
                children = cells[c] if c < len(cells) else []
                self._fill_cell(cell, children, is_header, band)

    def _apply_table_borders(self, table: Any) -> None:
        style = self.opts.table_style
        hairline = (NEUTRAL_BORDER, 4)
        if style == "banded":
            _set_table_borders(table, {"top": hairline, "bottom": hairline, "insideH": hairline})
        elif style == "grid":
            _set_table_borders(
                table,
                {
                    edge: hairline
                    for edge in ("top", "bottom", "left", "right", "insideH", "insideV")
                },
            )

    def _fill_cell(self, cell: Any, children: list[Token], is_header: bool, band: bool) -> None:
        t = self.theme
        style = self.opts.table_style
        paragraph = cell.paragraphs[0]
        if is_header:
            header_color = t.accent if style in ("minimal", "none") else "FFFFFF"
            profile = RunProfile(t.body_font, 10.0, header_color, t.mono_font, t.accent)
            if style in ("banded", "grid"):
                _set_cell_fill(cell, t.accent)
            if style == "minimal":
                _set_cell_border_bottom(cell, t.accent, 12)
        else:
            profile = RunProfile(t.body_font, 10.0, t.text_dark, t.mono_font, t.accent)
            if band:
                _set_cell_fill(cell, BAND_FILL)
        renderer = InlineRenderer(profile)
        renderer.render(paragraph, children)
        if is_header:
            for run in paragraph.runs:
                run.bold = True


# ============================================================
# Document setup (styles, page, header/footer, front matter)
# ============================================================


def _override_text_style(
    doc: Any,
    name: str,
    font: str,
    size_pt: float,
    color: str,
    bold: bool = False,
    italic: bool = False,
    space_before: float | None = None,
    space_after: float | None = None,
    line_spacing: float | None = None,
    keep_with_next: bool = False,
) -> None:
    try:
        style = doc.styles[name]
    except KeyError:
        return
    style.font.name = font
    style.font.size = Pt(size_pt)
    style.font.color.rgb = _rgb(color)
    style.font.bold = bold
    style.font.italic = italic
    fmt = style.paragraph_format
    if space_before is not None:
        fmt.space_before = Pt(space_before)
    if space_after is not None:
        fmt.space_after = Pt(space_after)
    if line_spacing is not None:
        fmt.line_spacing = line_spacing
    if keep_with_next:
        fmt.keep_with_next = True


def _setup_styles(doc: Any, opts: Options) -> None:
    t = opts.theme
    body = opts.font_size_pt
    _override_text_style(
        doc, "Normal", t.body_font, body, t.text_dark, space_after=6, line_spacing=opts.line_spacing
    )
    _override_text_style(
        doc,
        "Heading 1",
        t.heading_font,
        17,
        t.accent,
        bold=True,
        space_before=16,
        space_after=6,
        keep_with_next=True,
    )
    _override_text_style(
        doc,
        "Heading 2",
        t.heading_font,
        13.5,
        t.text_dark,
        bold=True,
        space_before=12,
        space_after=4,
        keep_with_next=True,
    )
    _override_text_style(
        doc,
        "Heading 3",
        t.heading_font,
        11.5,
        t.accent,
        bold=True,
        space_before=10,
        space_after=3,
        keep_with_next=True,
    )
    for name in ("Heading 4", "Heading 5", "Heading 6"):
        _override_text_style(
            doc,
            name,
            t.heading_font,
            11,
            t.text_muted,
            bold=True,
            italic=True,
            space_before=8,
            space_after=3,
            keep_with_next=True,
        )
    for name in _BULLET_STYLES:
        _override_text_style(
            doc, name, t.body_font, body, t.text_dark, space_after=2, line_spacing=opts.line_spacing
        )


def _setup_page(doc: Any, opts: Options) -> None:
    section = doc.sections[0]
    w, h = PAGE_SIZES[opts.page_size]
    if opts.orientation == "landscape":
        section.orientation = WD_ORIENT.LANDSCAPE
        w, h = h, w
    section.page_width = Inches(w)
    section.page_height = Inches(h)
    margin = Inches(opts.margin_inches)
    section.top_margin = margin
    section.bottom_margin = margin
    section.left_margin = margin
    section.right_margin = margin


def _setup_header_footer(doc: Any, opts: Options) -> None:
    t = opts.theme
    section = doc.sections[0]
    if opts.header_text:
        header = section.header
        header.is_linked_to_previous = False
        paragraph = header.paragraphs[0]
        paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        run = paragraph.add_run(opts.header_text)
        _set_run_font(run, t.body_font, 9.0, t.text_muted)
    if not opts.footer_text and not opts.include_page_numbers:
        return
    footer = section.footer
    footer.is_linked_to_previous = False
    paragraph = footer.paragraphs[0]
    if opts.footer_text:
        run = paragraph.add_run(opts.footer_text)
        _set_run_font(run, t.body_font, 9.0, t.text_muted)
        if opts.include_page_numbers:
            paragraph.paragraph_format.tab_stops.add_tab_stop(
                Inches(opts.content_width_in), WD_TAB_ALIGNMENT.RIGHT
            )
            paragraph.add_run("\t")
    else:
        paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    if opts.include_page_numbers:
        before = len(paragraph.runs)
        _add_field(paragraph, "PAGE")
        for run in paragraph.runs[before:]:
            _set_run_font(run, t.body_font, 9.0, t.text_muted)


def _meta_line(opts: Options) -> str | None:
    parts = [p for p in (opts.author, opts.date) if p]
    return "  ·  ".join(parts) if parts else None


def _add_front_matter(doc: Any, opts: Options, title: str) -> None:
    if opts.cover_page:
        _add_cover_page(doc, opts, title)
    else:
        _add_title_block(doc, opts, title)
    if opts.include_toc:
        _add_toc(doc, opts)


def _add_title_block(doc: Any, opts: Options, title: str) -> None:
    t = opts.theme
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.space_after = Pt(2)
    run = paragraph.add_run(title)
    run.bold = True
    _set_run_font(run, t.heading_font, 26, t.accent)
    if opts.subtitle:
        paragraph = doc.add_paragraph()
        paragraph.paragraph_format.space_after = Pt(2)
        _set_run_font(paragraph.add_run(opts.subtitle), t.body_font, 12, t.text_muted)
    meta = _meta_line(opts)
    if meta:
        paragraph = doc.add_paragraph()
        paragraph.paragraph_format.space_after = Pt(2)
        _set_run_font(paragraph.add_run(meta), t.body_font, 9.5, t.text_muted)
    rule = doc.add_paragraph()
    rule.paragraph_format.space_after = Pt(12)
    _paragraph_borders(rule, {"bottom": (t.accent, 8)})


def _add_cover_page(doc: Any, opts: Options, title: str) -> None:
    t = opts.theme
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_before = Pt(190)
    bar = doc.add_paragraph()
    bar.paragraph_format.space_after = Pt(18)
    bar.paragraph_format.right_indent = Inches(max(opts.content_width_in - 1.6, 0))
    _paragraph_borders(bar, {"top": (t.accent, 32)})
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.space_after = Pt(6)
    run = paragraph.add_run(title)
    run.bold = True
    _set_run_font(run, t.heading_font, 34, t.accent)
    if opts.subtitle:
        paragraph = doc.add_paragraph()
        _set_run_font(paragraph.add_run(opts.subtitle), t.body_font, 14, t.text_muted)
    meta = _meta_line(opts)
    if meta:
        paragraph = doc.add_paragraph()
        paragraph.paragraph_format.space_before = Pt(36)
        _set_run_font(paragraph.add_run(meta), t.body_font, 10.5, t.text_muted)
    doc.add_page_break()


def _add_toc(doc: Any, opts: Options) -> None:
    t = opts.theme
    heading = doc.add_paragraph(style=_style(doc, "Heading 1"))
    heading.add_run("Contents")
    paragraph = doc.add_paragraph()
    _add_field(
        paragraph,
        'TOC \\o "1-3" \\h \\z \\u',
        "[Right-click and choose Update Field to build the table of contents]",
    )
    _ = t
    doc.add_page_break()


# ============================================================
# Entry point
# ============================================================


def _load_markdown(spec: dict[str, Any]) -> str:
    markdown = spec.get("markdown")
    markdown_path = spec.get("markdown_path")
    if markdown and str(markdown).strip():
        return str(markdown)
    if markdown_path:
        with open(str(markdown_path), encoding="utf-8") as handle:
            return handle.read()
    raise ValueError("spec requires non-empty 'markdown' or 'markdown_path'")


def _plain_text(inline: Token) -> str:
    return "".join(
        child.content for child in (inline.children or []) if child.type in ("text", "code_inline")
    )


def _derive_title(tokens: list[Token], opts: Options) -> tuple[str, list[Token]]:
    """Use a leading H1 as the title (skipping it in the body) when appropriate."""
    if tokens and tokens[0].type == "heading_open" and tokens[0].tag == "h1":
        h1_text = _plain_text(tokens[1])
        if opts.title is None or opts.title == h1_text:
            return (opts.title or h1_text or "Document"), tokens[3:]
    return opts.title or "Document", tokens


def generate(spec: dict[str, Any]) -> dict[str, Any]:
    opts = parse_options(spec)
    markdown = _load_markdown(spec)
    parser = MarkdownIt("commonmark").enable(["table", "strikethrough"])
    tokens = parser.parse(markdown)
    title, body_tokens = _derive_title(tokens, opts)

    doc = Document()
    _setup_styles(doc, opts)
    _setup_page(doc, opts)
    _setup_header_footer(doc, opts)
    _add_front_matter(doc, opts, title)

    renderer = DocxRenderer(doc, opts)
    renderer.render(body_tokens)

    os.makedirs(os.path.dirname(opts.output_path) or ".", exist_ok=True)
    doc.save(opts.output_path)

    return {
        "path": os.path.abspath(opts.output_path),
        "title": title,
        "theme": opts.theme_name,
        "words": len(markdown.split()),
        **renderer.stats,
        "warnings": renderer.warnings,
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
