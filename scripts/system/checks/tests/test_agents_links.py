"""Fixtures for the AGENTS.md bootstrap/nested grammar checker.

Each negative fixture pins one rejection the grammar exists to make. A checker that
only ever sees the (already clean) repository proves nothing, so every rule below is
exercised against material that must fail.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from checks.check_agents_links import (
    ROOT_MAX_LINES,
    agents_files,
    check,
    validate_nested,
    validate_root,
)

# --------------------------------------------------------------------------- root


def test_root_accepts_invariants_guidance_and_next_level_index() -> None:
    text = (
        "# Penny Index\n\n"
        "## Public repository boundary (invariant)\n\n"
        "No tracked file may reference the operator's filesystem.\n\n"
        "## Index\n\n"
        "- [Agent Documentation](docs/agents/AGENTS.md): MUST READ FOR code changes — how Penny works\n"
        "- [Penny Protocols](docs/penny/AGENTS.md): READ WHEN a protocol trigger applies — procedural docs\n"
    )
    tracked = {"docs/agents/AGENTS.md", "docs/penny/AGENTS.md"}
    assert validate_root(text, tracked) == []


def test_root_rejects_link_to_leaf_document() -> None:
    """Extra-depth link: the root must not skip the index chain into a document."""
    text = "# Penny Index\n\n- [Prompt Architecture](docs/agents/prompts/architecture.md): layers\n"
    errors = validate_root(text, {"docs/agents/prompts/architecture.md"})
    assert any("links past the index chain" in e for e in errors)


@pytest.mark.parametrize(
    "line",
    [
        "- Main docs: `/home/operator/.bun/node_modules/pi/README.md`",
        "- Corpus: /Users/operator/private/corpus",
        "- Staging: ~/penny-private/inbox",
        "- Windows target: C:\\Users\\operator\\kb",
    ],
)
def test_root_rejects_operator_filesystem_paths(line: str) -> None:
    errors = validate_root(f"# Penny Index\n\n{line}\n", set())
    assert any("operator filesystem path" in e for e in errors)


def test_root_allows_project_root_variable_forms() -> None:
    """$PROJECT_ROOT and ${PI_PACKAGE_DIR} are the sanctioned generic spellings."""
    text = "# Penny Index\n\n- Docs live under `$PROJECT_ROOT/docs` and `${PI_PACKAGE_DIR}/docs`.\n"
    assert validate_root(text, set()) == []


def test_root_rejects_domain_detail_by_budget() -> None:
    """Bounded root: domain detail cannot accumulate in the always-on file."""
    bloat = "\n".join(
        f"Domain rule {i}: how to handle case {i}." for i in range(ROOT_MAX_LINES + 5)
    )
    errors = validate_root(f"# Penny Index\n\n{bloat}\n", set())
    assert any("bootstrap budget" in e for e in errors)


def test_root_rejects_missing_or_untracked_index_target() -> None:
    text = "# Penny Index\n\n- [Ghost](docs/ghost/AGENTS.md): not tracked\n"
    errors = validate_root(text, set())
    assert any("missing or untracked" in e for e in errors)


# ------------------------------------------------------------------------- nested


def _tracked_leaf_index() -> set[str]:
    return {
        "docs/agents/prompts/AGENTS.md",
        "docs/agents/prompts/architecture.md",
        "docs/agents/prompts/layer-reference.md",
    }


def test_nested_accepts_heading_plus_complete_direct_children() -> None:
    text = (
        "# Prompts Feature Index\n\n"
        "- [Architecture](architecture.md): READ WHEN changing prompt layers — layer structure and token budgets\n"
        "- [Layer Reference](layer-reference.md): CONSULT WHEN resolving layer ownership — named layers and responsibilities\n"
    )
    assert validate_nested("docs/agents/prompts/AGENTS.md", text, _tracked_leaf_index()) == []


@pytest.mark.parametrize(
    "prefix",
    (
        "MUST READ FOR relevant changes",
        "READ WHEN the feature is present",
        "CONSULT WHEN a question remains",
    ),
)
def test_nested_accepts_each_routing_modality(prefix: str) -> None:
    text = (
        "# Prompts Feature Index\n\n"
        f"- [Architecture](architecture.md): {prefix} — layer structure\n"
        "- [Layer Reference](layer-reference.md): READ WHEN resolving ownership — layers\n"
    )
    assert validate_nested("docs/agents/prompts/AGENTS.md", text, _tracked_leaf_index()) == []


@pytest.mark.parametrize(
    "description", ("layer structure", "MUST READ FOR", "REQUIRED FOR everything")
)
def test_nested_rejects_passive_empty_or_unknown_routing_modality(description: str) -> None:
    text = (
        "# Prompts Feature Index\n\n"
        f"- [Architecture](architecture.md): {description}\n"
        "- [Layer Reference](layer-reference.md): READ WHEN resolving ownership — layers\n"
    )
    errors = validate_nested("docs/agents/prompts/AGENTS.md", text, _tracked_leaf_index())
    assert any("must begin with one of" in error for error in errors)


def test_nested_rejects_prose() -> None:
    text = (
        "# Prompts Feature Index\n\n"
        "These indexes exist to conserve context windows.\n\n"
        "- [Architecture](architecture.md): layer structure\n"
        "- [Layer Reference](layer-reference.md): named layers\n"
    )
    errors = validate_nested("docs/agents/prompts/AGENTS.md", text, _tracked_leaf_index())
    assert any("prose is forbidden" in e for e in errors)


def test_nested_rejects_cross_directory_link() -> None:
    text = "# Prompts Feature Index\n\n- [Other](../memory/overview.md): different directory\n"
    errors = validate_nested(
        "docs/agents/prompts/AGENTS.md", text, {"docs/agents/memory/overview.md"}
    )
    assert any("links outside its own directory" in e for e in errors)


def test_nested_rejects_skipped_level() -> None:
    text = "# Agents Index\n\n- [Deep](prompts/architecture.md): skips the sub-index\n"
    errors = validate_nested("docs/agents/AGENTS.md", text, {"docs/agents/prompts/architecture.md"})
    assert any("not a direct child" in e for e in errors)


def test_nested_rejects_orphan_target() -> None:
    text = "# Prompts Feature Index\n\n- [Gone](removed.md): file no longer exists\n"
    errors = validate_nested(
        "docs/agents/prompts/AGENTS.md", text, {"docs/agents/prompts/AGENTS.md"}
    )
    assert any("missing or untracked" in e for e in errors)


def test_nested_rejects_missing_direct_child_entry() -> None:
    text = "# Prompts Feature Index\n\n- [Architecture](architecture.md): only one of two\n"
    errors = validate_nested("docs/agents/prompts/AGENTS.md", text, _tracked_leaf_index())
    assert any("missing entry for direct child layer-reference.md" in e for e in errors)


def test_nested_rejects_missing_subdirectory_index_entry() -> None:
    tracked = {
        "docs/agents/AGENTS.md",
        "docs/agents/prompts/AGENTS.md",
        "docs/agents/prompts/architecture.md",
    }
    errors = validate_nested("docs/agents/AGENTS.md", "# Agents Index\n", tracked)
    assert any("missing entry for direct child prompts/AGENTS.md" in e for e in errors)


def test_nested_rejects_duplicate_entries() -> None:
    text = (
        "# Prompts Feature Index\n\n"
        "- [Architecture](architecture.md): first\n"
        "- [Architecture Again](architecture.md): duplicate\n"
        "- [Layer Reference](layer-reference.md): named layers\n"
    )
    errors = validate_nested("docs/agents/prompts/AGENTS.md", text, _tracked_leaf_index())
    assert any("duplicate entry" in e for e in errors)


def test_nested_rejects_multiline_description() -> None:
    """A description continued on the next line is prose, not a one-line entry."""
    text = (
        "# Prompts Feature Index\n\n"
        "- [Architecture](architecture.md): layer structure\n"
        "  and token budgets and compliance principles\n"
        "- [Layer Reference](layer-reference.md): named layers\n"
    )
    errors = validate_nested("docs/agents/prompts/AGENTS.md", text, _tracked_leaf_index())
    assert any("prose is forbidden" in e for e in errors)


def test_nested_rejects_empty_description() -> None:
    text = (
        "# Prompts Feature Index\n\n"
        "- [Architecture](architecture.md)\n"
        "- [Layer Reference](layer-reference.md): named layers\n"
    )
    errors = validate_nested("docs/agents/prompts/AGENTS.md", text, _tracked_leaf_index())
    assert any("no one-line description" in e for e in errors)


def test_nested_rejects_subheadings() -> None:
    text = (
        "# Prompts Feature Index\n\n"
        "## Grouping\n\n"
        "- [Architecture](architecture.md): layer structure\n"
        "- [Layer Reference](layer-reference.md): named layers\n"
    )
    errors = validate_nested("docs/agents/prompts/AGENTS.md", text, _tracked_leaf_index())
    assert any("only one level-one heading" in e for e in errors)


def test_nested_rejects_missing_heading() -> None:
    text = "- [Architecture](architecture.md): layer structure\n- [Layer Reference](layer-reference.md): x\n"
    errors = validate_nested("docs/agents/prompts/AGENTS.md", text, _tracked_leaf_index())
    assert any("missing the level-one index heading" in e for e in errors)


# -------------------------------------------------------------- tracked enumeration


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "config", "user.email", "t@example.invalid")
    _git(tmp_path, "config", "user.name", "test")
    (tmp_path / "AGENTS.md").write_text(
        "# Root\n\n- [Docs](docs/agents/AGENTS.md): READ WHEN navigating docs — index\n",
        encoding="utf-8",
    )
    (tmp_path / "docs" / "agents").mkdir(parents=True)
    (tmp_path / "docs" / "agents" / "AGENTS.md").write_text(
        "# Agents Index\n\n- [Overview](overview.md): READ WHEN orienting to the docs — what this is\n",
        encoding="utf-8",
    )
    (tmp_path / "docs" / "agents" / "overview.md").write_text("# Overview\n", encoding="utf-8")
    return tmp_path


def test_clean_tracked_repository_passes(repo: Path) -> None:
    _git(repo, "add", "-A")
    assert check(repo) == []


def test_humans_agents_file_is_rejected(repo: Path) -> None:
    humans = repo / "docs" / "humans"
    humans.mkdir(parents=True)
    (humans / "AGENTS.md").write_text("# Humans\n", encoding="utf-8")
    _git(repo, "add", "-A")
    failures = check(repo)
    assert any("forbidden under docs/humans/" in f for f in failures)


def test_untracked_private_root_is_never_scanned(repo: Path) -> None:
    """An ignored, operator-configured KB root must not be opened or validated."""
    _git(repo, "add", "-A")
    private = repo / "private-kb"
    private.mkdir()
    (private / "AGENTS.md").write_text("this would fail every grammar rule", encoding="utf-8")
    (repo / ".gitignore").write_text("private-kb/\n", encoding="utf-8")
    _git(repo, "add", ".gitignore")

    assert check(repo) == []
    assert "private-kb/AGENTS.md" not in agents_files(
        subprocess.run(
            ["git", "-C", str(repo), "ls-files"], capture_output=True, text=True, check=True
        ).stdout.split()
    )
