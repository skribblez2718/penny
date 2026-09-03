from __future__ import annotations

from pathlib import Path

from checks.check_markdown_links import anchors, document_errors, in_scope


def write(root: Path, name: str, body: str) -> Path:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return path


def test_valid_relative_link_and_anchor_pass(tmp_path: Path) -> None:
    source = write(tmp_path, "docs/agents/source.md", "[Target](target.md#use-it)\n")
    write(tmp_path, "docs/agents/target.md", "# Use It\n")
    assert document_errors(tmp_path, source) == []


def test_missing_file_is_reported(tmp_path: Path) -> None:
    source = write(tmp_path, "docs/agents/source.md", "[Missing](gone.md)\n")
    assert any("missing local target" in error for error in document_errors(tmp_path, source))


def test_missing_anchor_is_reported(tmp_path: Path) -> None:
    source = write(tmp_path, "docs/agents/source.md", "[Target](target.md#missing)\n")
    write(tmp_path, "docs/agents/target.md", "# Present\n")
    assert any("missing heading anchor" in error for error in document_errors(tmp_path, source))


def test_external_mail_and_same_page_links_are_ignored(tmp_path: Path) -> None:
    source = write(
        tmp_path,
        "docs/agents/source.md",
        "[Web](https://example.invalid/a) [Mail](mailto:a@example.invalid) [Here](#later)\n",
    )
    assert document_errors(tmp_path, source) == []


def test_duplicate_heading_suffixes_match_github_style(tmp_path: Path) -> None:
    target = write(tmp_path, "docs/agents/target.md", "# Same\n## Same\n")
    source = write(tmp_path, "docs/agents/source.md", "[Target](target.md#same-1)\n")
    assert "same-1" in anchors(target)
    assert document_errors(tmp_path, source) == []


def test_scope_excludes_unlisted_private_and_human_paths() -> None:
    assert in_scope("docs/agents/coding/conventions.md")
    assert in_scope("docs/humans/coding/security-overview.md")
    assert not in_scope("private/notes.md")
    assert not in_scope("docs/humans/other.md")


def test_links_in_fenced_examples_are_not_document_links(tmp_path: Path) -> None:
    source = write(
        tmp_path, "docs/agents/source.md", "```markdown\n[Example](not-a-file.md)\n```\n"
    )
    assert document_errors(tmp_path, source) == []
