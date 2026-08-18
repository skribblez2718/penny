"""Fixtures for the knowledge-base privacy and admission gate.

The live repository is (and must stay) clean, so every rule is additionally exercised
against material that must fail. Admission tests build real temporary Git worktrees rather
than mocking Git, because the rules being tested are precisely about tracked/ignored status
and worktree containment.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from checks.check_kb_privacy import (
    LIVE_PATH_CLASSES,
    SCAFFOLD_FILES,
    SCAFFOLD_REL,
    admit_root,
    check_no_tracked_live_paths,
    check_scaffold_ignores,
    check_scaffold_shape,
    is_ignored,
)

SCAFFOLD_IGNORE = "*\n!.gitignore\n!README.md\n!manifest.example.json\n!templates/\n!templates/**\n"


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    """A miniature repository carrying the exact five-file scaffold."""
    root = tmp_path / "repo"
    (root / SCAFFOLD_REL / "templates").mkdir(parents=True)
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "t@example.invalid")
    _git(root, "config", "user.name", "test")

    scaffold = root / SCAFFOLD_REL
    # Pin modes explicitly: the ambient umask (often 0002) would otherwise make these
    # group-writable and turn every admission assertion below into a umask test.
    scaffold.chmod(0o755)
    (scaffold / "templates").chmod(0o755)
    (scaffold / ".gitignore").write_text(SCAFFOLD_IGNORE, encoding="utf-8")
    (scaffold / "README.md").write_text("# scaffold\n", encoding="utf-8")
    (scaffold / "manifest.example.json").write_text("{}\n", encoding="utf-8")
    (scaffold / "templates" / "page.md").write_text("# template\n", encoding="utf-8")
    (scaffold / "templates" / "source.json").write_text("{}\n", encoding="utf-8")
    _git(root, "add", "-A")
    return root


# ------------------------------------------------------------------ scaffold integrity


def test_clean_scaffold_passes(repo: Path) -> None:
    assert check_scaffold_shape(repo) == []
    assert check_scaffold_ignores(repo) == []
    assert check_no_tracked_live_paths(repo) == []


def test_every_live_path_class_is_ignored(repo: Path) -> None:
    for rel in LIVE_PATH_CLASSES:
        assert is_ignored(repo, f"{SCAFFOLD_REL}/{rel}"), rel


def test_scaffold_files_are_not_ignored(repo: Path) -> None:
    for name in SCAFFOLD_FILES:
        assert not is_ignored(repo, f"{SCAFFOLD_REL}/{name}")


def test_extra_tracked_scaffold_file_fails(repo: Path) -> None:
    (repo / SCAFFOLD_REL / "templates" / "extra.md").write_text("x\n", encoding="utf-8")
    _git(repo, "add", "-A")
    errors = check_scaffold_shape(repo)
    assert any("unexpected tracked file" in e for e in errors)


def test_missing_scaffold_file_fails(repo: Path) -> None:
    _git(repo, "rm", "-q", "--cached", f"{SCAFFOLD_REL}/README.md")
    errors = check_scaffold_shape(repo)
    assert any("missing tracked file" in e for e in errors)


def test_force_added_live_content_is_detected(repo: Path) -> None:
    """.gitignore is not the control: a force-added live file must still be caught."""
    live = repo / SCAFFOLD_REL / "pages" / "p" / "revisions" / "r"
    live.mkdir(parents=True)
    (live / "page.md").write_text("private body\n", encoding="utf-8")
    _git(repo, "add", "-f", f"{SCAFFOLD_REL}/pages/p/revisions/r/page.md")

    assert is_ignored(repo, f"{SCAFFOLD_REL}/pages/p/revisions/r/page.md")
    errors = check_no_tracked_live_paths(repo)
    assert any("force-added" in e for e in errors)


def test_weakened_ignore_grammar_fails(repo: Path) -> None:
    (repo / SCAFFOLD_REL / ".gitignore").write_text("!README.md\n", encoding="utf-8")
    errors = check_scaffold_ignores(repo)
    assert len(errors) >= len(LIVE_PATH_CLASSES)


# --------------------------------------------------------------------- root admission


def test_outside_worktree_root_is_admitted(tmp_path: Path) -> None:
    root = tmp_path / "private-kb"
    root.mkdir(mode=0o700)
    assert admit_root(root) == []


def test_inside_worktree_root_is_denied_by_default(repo: Path) -> None:
    """Default-deny: worktree containment alone is refusal without an explicit declaration."""
    errors = admit_root(repo / SCAFFOLD_REL)
    assert any("does not declare" in e for e in errors)


def test_declared_scaffold_root_is_admitted(repo: Path) -> None:
    scaffold = repo / SCAFFOLD_REL
    errors = admit_root(scaffold, scaffold_root=scaffold, allow_inside_scaffold=True)
    assert errors == []


def test_alternate_in_repo_root_is_denied(repo: Path) -> None:
    """A declaration authorizes one exact scaffold, not any in-repository directory."""
    other = repo / "docs" / "other-kb"
    other.mkdir(parents=True)
    errors = admit_root(other, scaffold_root=repo / SCAFFOLD_REL, allow_inside_scaffold=True)
    assert any("not the exact allowlisted scaffold" in e for e in errors)


def test_nested_repository_is_denied(repo: Path) -> None:
    nested = repo / SCAFFOLD_REL / "nested"
    nested.mkdir()
    (nested / ".git").mkdir()
    scaffold = repo / SCAFFOLD_REL
    errors = admit_root(scaffold, scaffold_root=scaffold, allow_inside_scaffold=True)
    assert any("nested repository or worktree" in e for e in errors)


def test_symlinked_root_is_denied(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir(mode=0o700)
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    errors = admit_root(link)
    assert any("symlink component" in e for e in errors)


def test_missing_root_is_denied(tmp_path: Path) -> None:
    errors = admit_root(tmp_path / "absent")
    assert any("does not exist" in e for e in errors)


def test_file_root_is_denied(tmp_path: Path) -> None:
    target = tmp_path / "afile"
    target.write_text("x", encoding="utf-8")
    errors = admit_root(target)
    assert any("not a directory" in e for e in errors)


@pytest.mark.skipif(os.name != "posix", reason="POSIX permission semantics")
def test_group_or_other_accessible_root_is_denied(tmp_path: Path) -> None:
    """Custody must not depend on the ambient umask."""
    root = tmp_path / "loose-kb"
    root.mkdir(mode=0o755)
    errors = admit_root(root)
    assert any("group/other accessible" in e for e in errors)


@pytest.mark.skipif(os.name != "posix", reason="POSIX permission semantics")
def test_hostile_umask_does_not_admit_a_loose_root(tmp_path: Path) -> None:
    previous = os.umask(0o000)
    try:
        root = tmp_path / "umask-kb"
        root.mkdir(mode=0o777)
        errors = admit_root(root)
        assert any("group/other accessible" in e for e in errors)
    finally:
        os.umask(previous)


def test_unignored_live_path_in_scaffold_is_denied(repo: Path) -> None:
    """A scaffold whose ignore grammar stops covering live paths loses admission."""
    (repo / SCAFFOLD_REL / ".gitignore").write_text("!README.md\n", encoding="utf-8")
    scaffold = repo / SCAFFOLD_REL
    errors = admit_root(scaffold, scaffold_root=scaffold, allow_inside_scaffold=True)
    assert any("would not be ignored" in e for e in errors)


@pytest.mark.skipif(os.name != "posix", reason="POSIX permission semantics")
def test_scaffold_root_may_keep_public_read_but_not_write(repo: Path) -> None:
    """A tracked public scaffold is necessarily world-readable; world-writable is not."""
    scaffold = repo / SCAFFOLD_REL
    scaffold.chmod(0o755)
    assert admit_root(scaffold, scaffold_root=scaffold, allow_inside_scaffold=True) == []

    scaffold.chmod(0o777)
    errors = admit_root(scaffold, scaffold_root=scaffold, allow_inside_scaffold=True)
    assert any("group/other writable" in e for e in errors)
    scaffold.chmod(0o755)


@pytest.mark.skipif(os.name != "posix", reason="POSIX permission semantics")
def test_group_writable_scaffold_is_denied(repo: Path) -> None:
    """A umask of 0002 yields 0775 directories; that is disqualifying, and must fail closed."""
    scaffold = repo / SCAFFOLD_REL
    scaffold.chmod(0o775)
    errors = admit_root(scaffold, scaffold_root=scaffold, allow_inside_scaffold=True)
    assert any("group/other writable" in e for e in errors)
    scaffold.chmod(0o755)


@pytest.mark.skipif(os.name != "posix", reason="POSIX permission semantics")
def test_live_directory_beneath_scaffold_must_be_owner_only(repo: Path) -> None:
    """The scaffold root may be public; live data beneath it may not."""
    scaffold = repo / SCAFFOLD_REL
    (scaffold / "pages").mkdir(mode=0o755)
    errors = admit_root(scaffold, scaffold_root=scaffold, allow_inside_scaffold=True)
    assert any("live KB directory is group/other accessible" in e for e in errors)

    (scaffold / "pages").chmod(0o700)
    assert admit_root(scaffold, scaffold_root=scaffold, allow_inside_scaffold=True) == []
