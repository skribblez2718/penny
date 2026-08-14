from __future__ import annotations

from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from conftest import generate_deck, slide_texts


def test_twelve_short_bullets_stay_on_one_slide(tmp_path: Path, powerpointgen: ModuleType) -> None:
    bullets = [f"Item {index}" for index in range(12)]
    result, presentation = generate_deck(
        powerpointgen,
        tmp_path,
        slides=[{"layout": "content", "title": "Compact", "bullets": bullets}],
    )
    assert result["slide_count"] == 1
    joined = "\n".join(slide_texts(presentation))
    assert all(item in joined for item in bullets)


def test_seven_long_bullets_split_without_loss(tmp_path: Path, powerpointgen: ModuleType) -> None:
    bullets = [f"BULLET-{index} " + "detail " * 42 for index in range(7)]
    result, presentation = generate_deck(
        powerpointgen,
        tmp_path,
        slides=[{"layout": "content", "title": "Long bullets", "bullets": bullets}],
    )
    assert result["slide_count"] > 1
    joined = "\n".join(slide_texts(presentation))
    assert all(joined.count(f"BULLET-{index}") == 1 for index in range(7))
    assert any("(cont.)" in text for text in slide_texts(presentation))


def test_body_paragraphs_paginate_without_loss(tmp_path: Path, powerpointgen: ModuleType) -> None:
    paragraphs = [f"[PARAGRAPH-{index:02d}] " + "word " * 36 for index in range(18)]
    markdown = "## Body\n\n" + "\n\n".join(paragraphs)
    result, presentation = generate_deck(powerpointgen, tmp_path, markdown=markdown)
    assert result["slide_count"] > 1
    joined = "\n".join(slide_texts(presentation))
    assert all(joined.count(f"[PARAGRAPH-{index:02d}]") == 1 for index in range(18))


def test_single_unfit_paragraph_fails_without_output(
    tmp_path: Path, powerpointgen: ModuleType
) -> None:
    output = tmp_path / "paragraph-overflow.pptx"
    with pytest.raises(ValueError, match="single paragraph"):
        powerpointgen.generate(
            {
                "slides": [{"layout": "content", "title": "Too long", "body": "word " * 3000}],
                "output_path": str(output),
            }
        )
    assert not output.exists()


def test_long_code_continues_and_preserves_every_source_line(
    tmp_path: Path, powerpointgen: ModuleType
) -> None:
    source_lines = [f"CODE-LINE-{index:02d} = {index}" for index in range(31)]
    markdown = "## Code\n\n```python\n" + "\n".join(source_lines) + "\n```"
    result, presentation = generate_deck(powerpointgen, tmp_path, markdown=markdown)
    assert result["slide_count"] > 1
    joined = "\n".join(slide_texts(presentation))
    assert all(joined.count(line) == 1 for line in source_lines)
    assert not any("truncat" in warning or "clamp" in warning for warning in result["warnings"])


def test_internal_blank_code_lines_survive(tmp_path: Path, powerpointgen: ModuleType) -> None:
    _, presentation = generate_deck(
        powerpointgen,
        tmp_path,
        markdown="## Code\n\n```text\nfirst\n\nthird\n```",
    )
    code_shape = next(
        shape
        for shape in presentation.slides[0].shapes
        if getattr(shape, "has_text_frame", False) and "first" in shape.text
    )
    assert len(code_shape.text_frame.paragraphs) == 3
    assert code_shape.text_frame.paragraphs[1].text.strip() == ""


def test_long_code_line_is_not_silently_cut(tmp_path: Path, powerpointgen: ModuleType) -> None:
    source = "LONG=" + "abcdef" * 120
    _, presentation = generate_deck(
        powerpointgen,
        tmp_path,
        markdown=f"## Code\n\n```text\n{source}\n```",
    )
    rendered = "".join(slide_texts(presentation)).replace("\n", "").replace(" ", "")
    assert source in rendered


def test_mixed_body_code_and_bullets_keep_normalized_order(
    tmp_path: Path, powerpointgen: ModuleType
) -> None:
    body = "\n\n".join(f"BODY-{index} " + "word " * 160 for index in range(3))
    _, presentation = generate_deck(
        powerpointgen,
        tmp_path,
        slides=[
            {
                "layout": "content",
                "title": "Ordered",
                "body": body,
                "code": ["CODE-SENTINEL"],
                "bullets": ["BULLET-SENTINEL"],
            }
        ],
    )
    rendered = "\n".join(slide_texts(presentation))
    markers = ["BODY-0", "BODY-1", "BODY-2", "CODE-SENTINEL", "BULLET-SENTINEL"]
    assert [rendered.index(marker) for marker in markers] == sorted(
        rendered.index(marker) for marker in markers
    )


def test_word_aware_estimator_wraps_whole_words(tmp_path: Path, powerpointgen: ModuleType) -> None:
    options = powerpointgen.parse_options(
        {"slides": [{"layout": "title"}], "output_path": str(tmp_path / "metrics.pptx")}
    )
    body = next(choice for choice in options.font_plan if choice.role == "body")
    source = (body.metrics_path, body.metrics_face_index) if body.metrics_path is not None else None
    assert powerpointgen._segment_line_count(" ".join(["W" * 9] * 3), 3.0, 14.0, source) == 3


def _metric_sources(powerpointgen: ModuleType, tmp_path: Path) -> tuple[Any, Any]:
    options = powerpointgen.parse_options(
        {"slides": [{"layout": "title"}], "output_path": str(tmp_path / "metrics.pptx")}
    )
    body = next(choice for choice in options.font_plan if choice.role == "body")
    mono = next(choice for choice in options.font_plan if choice.role == "mono")
    body_source = (
        (body.metrics_path, body.metrics_face_index) if body.metrics_path is not None else None
    )
    mono_source = (
        (mono.metrics_path, mono.metrics_face_index) if mono.metrics_path is not None else None
    )
    return body_source, mono_source


def _inline_code_divergence(
    powerpointgen: ModuleType,
    width: float,
    font_pt: float,
    body_source: Any,
    mono_source: Any,
) -> str:
    for length in range(1, 2000):
        text = f"`{'i' * length}`"
        body_lines = powerpointgen._estimate_lines(
            text, width, font_pt, "preserve", body_source, body_source
        )
        run_lines = powerpointgen._estimate_lines(
            text, width, font_pt, "preserve", body_source, mono_source
        )
        if run_lines > body_lines:
            return text
    raise AssertionError("test fonts did not produce a body/mono wrap divergence")


def test_inline_mono_metrics_drive_every_inline_capable_layout(
    tmp_path: Path, powerpointgen: ModuleType
) -> None:
    body_source, mono_source = _metric_sources(powerpointgen, tmp_path)

    body_text = _inline_code_divergence(
        powerpointgen,
        powerpointgen.CONTENT_W,
        powerpointgen.BODY_FONT_PT,
        body_source,
        mono_source,
    )
    expected_body_height = powerpointgen._body_paragraph_height(
        body_text,
        "preserve",
        body_source,
        mono_source,
    )
    _, body_presentation = generate_deck(
        powerpointgen,
        tmp_path,
        name="inline-body-metrics",
        slides=[{"layout": "content", "body": body_text}],
    )
    body_shape = next(
        shape
        for shape in body_presentation.slides[0].shapes
        if getattr(shape, "has_text_frame", False) and "i" in shape.text
    )
    assert body_shape.height / 914400 == pytest.approx(expected_body_height)

    bullet_sizes = powerpointgen.BULLET_FONT_TIERS[0]
    bullet_text = _inline_code_divergence(
        powerpointgen,
        powerpointgen.CONTENT_W * 0.95,
        bullet_sizes[0],
        body_source,
        mono_source,
    )
    bullet = {"text": bullet_text, "level": 0, "bold": False}
    expected_bullet_height = powerpointgen._bullet_height(
        bullet,
        bullet_sizes,
        "preserve",
        body_source,
        mono_source,
    )
    _, bullet_presentation = generate_deck(
        powerpointgen,
        tmp_path,
        name="inline-bullet-metrics",
        slides=[{"layout": "content", "bullets": [bullet]}],
    )
    bullet_shape = next(
        shape
        for shape in bullet_presentation.slides[0].shapes
        if getattr(shape, "has_text_frame", False) and "i" in shape.text
    )
    assert bullet_shape.height / 914400 == pytest.approx(expected_bullet_height)

    table_text = _inline_code_divergence(
        powerpointgen,
        powerpointgen.CONTENT_W - 0.24,
        powerpointgen.TABLE_BODY_FONT_PT,
        body_source,
        mono_source,
    )
    expected_row_height = powerpointgen._table_row_height(
        [table_text],
        powerpointgen.CONTENT_W,
        "preserve",
        body_source,
        mono_source,
    )
    _, table_presentation = generate_deck(
        powerpointgen,
        tmp_path,
        name="inline-table-metrics",
        slides=[
            {
                "layout": "table",
                "table": {"headers": ["Header"], "rows": [[table_text]]},
            }
        ],
    )
    table_shape = next(
        shape for shape in table_presentation.slides[0].shapes if getattr(shape, "has_table", False)
    )
    assert table_shape.table.rows[1].height / 914400 == pytest.approx(expected_row_height)

    column_width = (powerpointgen.CONTENT_W - 0.6) / 2
    column_font_pt = 13.0
    column_line_height = (
        column_font_pt * powerpointgen.BULLET_LINE_HEIGHT_FACTOR / powerpointgen.POINTS_PER_INCH
    )
    column_text = _inline_code_divergence(
        powerpointgen,
        column_width,
        column_font_pt,
        body_source,
        mono_source,
    )
    expected_column_height = powerpointgen._body_paragraph_height(
        column_text,
        "preserve",
        body_source,
        mono_source,
        width_in=column_width,
        font_pt=column_font_pt,
        line_height_in=column_line_height,
    )
    _, column_presentation = generate_deck(
        powerpointgen,
        tmp_path,
        name="inline-column-metrics",
        slides=[
            {
                "layout": "two_column",
                "left": {"body": column_text},
                "right": {"body": "Right"},
            }
        ],
    )
    column_shape = next(
        shape
        for shape in column_presentation.slides[0].shapes
        if getattr(shape, "has_text_frame", False) and "i" in shape.text
    )
    assert column_shape.height / 914400 == pytest.approx(expected_column_height)

    fixed_text = _inline_code_divergence(
        powerpointgen,
        1.0,
        14.0,
        body_source,
        mono_source,
    )
    builder = powerpointgen.PptxBuilder(
        powerpointgen.parse_options(
            {"slides": [{"layout": "title"}], "output_path": str(tmp_path / "fixed.pptx")}
        )
    )
    with pytest.raises(ValueError, match="does not fit"):
        builder._assert_text_fits(
            fixed_text,
            1.0,
            14.0 * 1.15 / powerpointgen.POINTS_PER_INCH,
            14.0,
            builder.theme.body_font,
            "fixed",
        )


def _font_metric_plan(choice: Any, powerpointgen: ModuleType) -> Any:
    return powerpointgen.FontMetricPlan(
        regular=(
            (choice.metrics_path, choice.metrics_face_index)
            if choice.metrics_path is not None
            else None
        ),
        styles=dict(choice.metrics_styles or {}),
    )


def _bold_divergence(
    powerpointgen: ModuleType,
    width: float,
    font_pt: float,
    regular_source: Any,
    style_plan: Any,
) -> str:
    for length in range(1, 2000):
        text = '"' * length
        regular_lines = powerpointgen._estimate_lines(
            text,
            width,
            font_pt,
            "preserve",
            regular_source,
            bold=True,
        )
        bold_lines = powerpointgen._estimate_lines(
            text,
            width,
            font_pt,
            "preserve",
            style_plan,
            bold=True,
        )
        if bold_lines > regular_lines:
            return text
    raise AssertionError("test font did not produce a regular/bold wrap divergence")


def test_style_specific_metrics_drive_every_inline_capable_layout(
    tmp_path: Path, powerpointgen: ModuleType
) -> None:
    options = powerpointgen.parse_options(
        {"slides": [{"layout": "title"}], "output_path": str(tmp_path / "styles.pptx")}
    )
    body_choice = next(choice for choice in options.font_plan if choice.role == "body")
    mono_choice = next(choice for choice in options.font_plan if choice.role == "mono")
    body_regular = (body_choice.metrics_path, body_choice.metrics_face_index)
    body_plan = _font_metric_plan(body_choice, powerpointgen)
    mono_plan = _font_metric_plan(mono_choice, powerpointgen)

    body_visible = _bold_divergence(
        powerpointgen,
        powerpointgen.CONTENT_W,
        powerpointgen.BODY_FONT_PT,
        body_regular,
        body_plan,
    )
    body_text = f"**{body_visible}**"
    expected_body_height = powerpointgen._body_paragraph_height(
        body_text,
        "preserve",
        body_plan,
        mono_plan,
    )
    _, body_presentation = generate_deck(
        powerpointgen,
        tmp_path,
        name="bold-body-metrics",
        slides=[{"layout": "content", "body": body_text}],
    )
    body_shape = next(
        shape
        for shape in body_presentation.slides[0].shapes
        if getattr(shape, "has_text_frame", False) and '"' in shape.text
    )
    assert body_shape.height / 914400 == pytest.approx(expected_body_height)
    assert any(
        run.font.bold is True and '"' in run.text
        for run in body_shape.text_frame.paragraphs[0].runs
    )

    bullet_sizes = powerpointgen.BULLET_FONT_TIERS[0]
    bullet_visible = _bold_divergence(
        powerpointgen,
        powerpointgen.CONTENT_W * 0.95,
        bullet_sizes[0],
        body_regular,
        body_plan,
    )
    bullet = {"text": bullet_visible, "level": 0, "bold": True}
    expected_bullet_height = powerpointgen._bullet_height(
        bullet,
        bullet_sizes,
        "preserve",
        body_plan,
        mono_plan,
    )
    _, bullet_presentation = generate_deck(
        powerpointgen,
        tmp_path,
        name="bold-bullet-metrics",
        slides=[{"layout": "content", "bullets": [bullet]}],
    )
    bullet_shape = next(
        shape
        for shape in bullet_presentation.slides[0].shapes
        if getattr(shape, "has_text_frame", False) and '"' in shape.text
    )
    assert bullet_shape.height / 914400 == pytest.approx(expected_bullet_height)

    header_visible = _bold_divergence(
        powerpointgen,
        powerpointgen.CONTENT_W - 0.24,
        powerpointgen.TABLE_HEADER_FONT_PT,
        body_regular,
        body_plan,
    )
    expected_header_height = powerpointgen._table_row_height(
        [header_visible],
        powerpointgen.CONTENT_W,
        "preserve",
        body_plan,
        mono_plan,
        font_pt=powerpointgen.TABLE_HEADER_FONT_PT,
        minimum=powerpointgen.TABLE_HEADER_MIN_HEIGHT_IN,
        bold=True,
    )
    _, table_presentation = generate_deck(
        powerpointgen,
        tmp_path,
        name="bold-table-metrics",
        slides=[
            {
                "layout": "table",
                "table": {"headers": [header_visible], "rows": [["Value"]]},
            }
        ],
    )
    table_shape = next(
        shape for shape in table_presentation.slides[0].shapes if getattr(shape, "has_table", False)
    )
    assert table_shape.table.rows[0].height / 914400 == pytest.approx(expected_header_height)

    column_width = (powerpointgen.CONTENT_W - 0.6) / 2
    column_font_pt = 13.0
    column_line_height = (
        column_font_pt * powerpointgen.BULLET_LINE_HEIGHT_FACTOR / powerpointgen.POINTS_PER_INCH
    )
    column_visible = _bold_divergence(
        powerpointgen,
        column_width,
        column_font_pt,
        body_regular,
        body_plan,
    )
    column_text = f"**{column_visible}**"
    expected_column_height = powerpointgen._body_paragraph_height(
        column_text,
        "preserve",
        body_plan,
        mono_plan,
        width_in=column_width,
        font_pt=column_font_pt,
        line_height_in=column_line_height,
    )
    _, column_presentation = generate_deck(
        powerpointgen,
        tmp_path,
        name="bold-column-metrics",
        slides=[
            {
                "layout": "two_column",
                "left": {"body": column_text},
                "right": {"body": "Right"},
            }
        ],
    )
    column_shape = next(
        shape
        for shape in column_presentation.slides[0].shapes
        if getattr(shape, "has_text_frame", False) and '"' in shape.text
    )
    assert column_shape.height / 914400 == pytest.approx(expected_column_height)

    fixed_visible = _bold_divergence(
        powerpointgen,
        1.0,
        14.0,
        body_regular,
        body_plan,
    )
    builder = powerpointgen.PptxBuilder(options)
    with pytest.raises(ValueError, match="does not fit"):
        builder._assert_text_fits(
            fixed_visible,
            1.0,
            14.0 * 1.15 / powerpointgen.POINTS_PER_INCH,
            14.0,
            builder.theme.body_font,
            "fixed",
            bold=True,
        )


def test_single_bullet_uses_largest_fitting_declared_tier(
    tmp_path: Path, powerpointgen: ModuleType
) -> None:
    _, presentation = generate_deck(
        powerpointgen,
        tmp_path,
        slides=[{"layout": "content", "bullets": ["word " * 360]}],
    )
    bullet_shape = next(
        shape
        for shape in presentation.slides[0].shapes
        if getattr(shape, "has_text_frame", False) and "word" in shape.text
    )
    sizes = [
        run.font.size.pt
        for paragraph in bullet_shape.text_frame.paragraphs
        for run in paragraph.runs
    ]
    assert sizes and min(sizes) == max(sizes) == 14.0


def test_code_geometry_and_two_column_stacks_do_not_overlap(
    tmp_path: Path, powerpointgen: ModuleType
) -> None:
    _, code_presentation = generate_deck(
        powerpointgen,
        tmp_path,
        name="code-geometry",
        markdown="## Code\n\n```text\nCODE-SENTINEL\n```",
    )
    code_shape = next(
        shape
        for shape in code_presentation.slides[0].shapes
        if getattr(shape, "has_text_frame", False) and "CODE-SENTINEL" in shape.text
    )
    assert code_shape.height / 914400 == pytest.approx(powerpointgen.CODE_LINE_HEIGHT_IN)
    assert code_shape.text_frame.margin_top == 0
    assert code_shape.text_frame.margin_bottom == 0
    assert code_shape.text_frame.paragraphs[0].runs[0].font.size.pt == powerpointgen.CODE_FONT_PT

    _, column_presentation = generate_deck(
        powerpointgen,
        tmp_path,
        name="column-geometry",
        slides=[
            {
                "layout": "two_column",
                "left": {
                    "body": "BODY-SENTINEL",
                    "bullets": [{"text": "normal `INLINE-CODE`", "level": 2}],
                },
                "right": {"body": "Right"},
            }
        ],
    )
    body_shape = next(
        shape
        for shape in column_presentation.slides[0].shapes
        if getattr(shape, "has_text_frame", False) and "BODY-SENTINEL" in shape.text
    )
    bullet_shape = next(
        shape
        for shape in column_presentation.slides[0].shapes
        if getattr(shape, "has_text_frame", False) and "INLINE-CODE" in shape.text
    )
    assert body_shape.top + body_shape.height <= bullet_shape.top
    emitted_sizes = [
        run.font.size.pt
        for paragraph in bullet_shape.text_frame.paragraphs
        for run in paragraph.runs
    ]
    assert emitted_sizes and min(emitted_sizes) >= 11.0


def test_multiple_markdown_tables_survive_in_order(
    tmp_path: Path, powerpointgen: ModuleType
) -> None:
    _, presentation = generate_deck(
        powerpointgen,
        tmp_path,
        markdown=("## Tables\n\n| Marker |\n|---|\n| FIRST |\n\n" "| Marker |\n|---|\n| SECOND |"),
    )
    rendered_rows = [
        [cell.text for cell in row.cells]
        for slide in presentation.slides
        for shape in slide.shapes
        if getattr(shape, "has_table", False)
        for row in list(shape.table.rows)[1:]
    ]
    assert rendered_rows == [["FIRST"], ["SECOND"]]


def test_table_intro_moves_before_a_row_that_only_fits_a_clean_page(
    tmp_path: Path, powerpointgen: ModuleType
) -> None:
    result, presentation = generate_deck(
        powerpointgen,
        tmp_path,
        slides=[
            {
                "layout": "table",
                "title": "Large row",
                "body": "intro " * 20,
                "table": {"headers": ["Header"], "rows": [["word " * 500]]},
            }
        ],
    )
    assert result["slide_count"] == 2
    assert not any(getattr(shape, "has_table", False) for shape in presentation.slides[0].shapes)
    assert any(getattr(shape, "has_table", False) for shape in presentation.slides[1].shapes)


def test_table_rows_paginate_repeat_header_and_preserve_order(
    tmp_path: Path, powerpointgen: ModuleType
) -> None:
    rows = [[f"ROW-{index:02d}", f"value-{index}"] for index in range(40)]
    result, presentation = generate_deck(
        powerpointgen,
        tmp_path,
        slides=[
            {
                "layout": "table",
                "title": "Rows",
                "table": {"headers": ["Marker", "Value"], "rows": rows},
            }
        ],
    )
    assert result["slide_count"] > 1
    tables = [
        shape.table
        for slide in presentation.slides
        for shape in slide.shapes
        if getattr(shape, "has_table", False)
    ]
    assert all(
        [cell.text for cell in table.rows[0].cells] == ["Marker", "Value"] for table in tables
    )
    rendered_rows = [
        [cell.text for cell in row.cells] for table in tables for row in list(table.rows)[1:]
    ]
    assert rendered_rows == rows
    assert not any("truncat" in warning for warning in result["warnings"])


def test_table_with_intro_accounts_for_available_height(
    tmp_path: Path, powerpointgen: ModuleType
) -> None:
    rows = [[f"ROW-{index}", "detail " * 12] for index in range(18)]
    _, presentation = generate_deck(
        powerpointgen,
        tmp_path,
        slides=[
            {
                "layout": "table",
                "title": "Rows",
                "body": "Introductory context " * 12,
                "table": {"headers": ["Marker", "Details"], "rows": rows},
            }
        ],
    )
    slide_height = presentation.slide_height
    for slide in presentation.slides:
        assert all(shape.top + shape.height <= slide_height for shape in slide.shapes)


def test_over_tall_table_row_fails_without_output(
    tmp_path: Path, powerpointgen: ModuleType
) -> None:
    output = tmp_path / "row-overflow.pptx"
    with pytest.raises(ValueError, match="single table row"):
        powerpointgen.generate(
            {
                "slides": [
                    {
                        "layout": "table",
                        "table": {"headers": ["A"], "rows": [["word " * 4000]]},
                    }
                ],
                "output_path": str(output),
            }
        )
    assert not output.exists()


def test_two_column_overflow_fails_closed(tmp_path: Path, powerpointgen: ModuleType) -> None:
    output = tmp_path / "column-overflow.pptx"
    with pytest.raises(ValueError, match="does not fit"):
        powerpointgen.generate(
            {
                "slides": [
                    {
                        "layout": "two_column",
                        "left": {"body": "word " * 1000},
                        "right": {"body": "short"},
                    }
                ],
                "output_path": str(output),
            }
        )
    assert not output.exists()


@pytest.mark.parametrize(
    "layout,field",
    [("title", "title"), ("section", "title"), ("quote", "quote"), ("closing", "title")],
)
def test_fixed_layout_overflow_fails_closed(
    tmp_path: Path, powerpointgen: ModuleType, layout: str, field: str
) -> None:
    output = tmp_path / f"{layout}-overflow.pptx"
    with pytest.raises(ValueError, match="does not fit|overflow"):
        powerpointgen.generate(
            {
                "slides": [{"layout": layout, field: "unbroken" * 1200}],
                "output_path": str(output),
            }
        )
    assert not output.exists()
