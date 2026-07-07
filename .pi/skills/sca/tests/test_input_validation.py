"""
Unit tests for sca input_validator.py (Phase 2).

Covers the two pure, network-free functions:
  - is_url_shaped(target_path) -> bool
      Rejects live-URL / remote targets (those belong to the jsa skill), while
      letting ambiguous bare strings fall through to normal path validation.
  - detect_lockfiles(target_path) -> {"lockfiles": [...], "workspace_count": N}
      Bounded, node_modules/.git-ignoring filesystem walk that records the JS/TS
      lockfiles found and how many distinct workspace roots contain one. Multiple
      workspaces are treated as ONE analysis unit (never a hard fail).

These functions must NOT touch the network and must degrade gracefully on
mixed-language / multi-workspace / empty repos.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from input_validator import (  # noqa: E402
    is_url_shaped,
    detect_lockfiles,
    LOCKFILE_NAMES,
)


# ── is_url_shaped ────────────────────────────────────────────────────────


class TestIsUrlShaped:
    @pytest.mark.parametrize(
        "value",
        [
            "http://example.com",
            "https://example.com/repo",
            "https://example.com/a/b?x=1#frag",
            "HTTP://EXAMPLE.COM",  # case-insensitive scheme
            "git://github.com/org/repo.git",
            "ssh://git@github.com/org/repo.git",
            "ftp://files.example.com/x",
            "git+ssh://git@host/repo.git",
            "git@github.com:org/repo.git",  # scp-style git remote
        ],
    )
    def test_url_shaped_values_rejected(self, value):
        assert is_url_shaped(value) is True

    @pytest.mark.parametrize(
        "value",
        [
            "/tmp/some/local/path",
            "./relative/path",
            "../up/one",
            "sample-repo",
            "example.com/repo",  # bare domain: ambiguous -> falls through
            "www.example.com",   # bare host: ambiguous -> falls through
            "./https:",          # literal dir name, NOT a url (no '//')
            "C:\\Users\\x\\repo",  # windows-ish path, no scheme://
            "",
            "   ",
        ],
    )
    def test_non_url_values_pass_through(self, value):
        assert is_url_shaped(value) is False

    def test_none_and_non_str_are_not_url(self):
        assert is_url_shaped(None) is False
        assert is_url_shaped(12345) is False
        assert is_url_shaped(["http://x"]) is False

    def test_generic_custom_scheme_is_url_shaped(self):
        # Any RFC-3986-ish scheme:// prefix counts, not just the well-known set.
        assert is_url_shaped("custom-scheme://host/path") is True
        assert is_url_shaped("s3://bucket/key") is True


# ── detect_lockfiles ─────────────────────────────────────────────────────


class TestDetectLockfiles:
    def test_expected_lockfile_name_set(self):
        assert LOCKFILE_NAMES == frozenset(
            {
                "pnpm-lock.yaml",
                "yarn.lock",
                "package-lock.json",
                "npm-shrinkwrap.json",
                "bun.lock",
                "bun.lockb",
            }
        )

    @pytest.mark.parametrize(
        "filename",
        [
            "pnpm-lock.yaml",
            "yarn.lock",
            "package-lock.json",
            "npm-shrinkwrap.json",
            "bun.lock",
            "bun.lockb",
        ],
    )
    def test_each_lockfile_variant_detected(self, tmp_path, filename):
        (tmp_path / filename).write_text("lock\n")
        result = detect_lockfiles(str(tmp_path))
        names = [Path(p).name for p in result["lockfiles"]]
        assert filename in names
        assert result["workspace_count"] == 1

    def test_no_lockfiles_returns_empty_and_count_one(self, tmp_path):
        (tmp_path / "main.go").write_text("package main\n")
        result = detect_lockfiles(str(tmp_path))
        assert result["lockfiles"] == []
        assert result["workspace_count"] == 1

    def test_multi_workspace_monorepo_counts_distinct_roots(self, tmp_path):
        # Two package workspaces, each with its own lockfile -> ONE analysis
        # unit but workspace_count == 2.
        (tmp_path / "package-lock.json").write_text("root\n")
        pkg_a = tmp_path / "packages" / "a"
        pkg_b = tmp_path / "packages" / "b"
        pkg_a.mkdir(parents=True)
        pkg_b.mkdir(parents=True)
        (pkg_a / "yarn.lock").write_text("a\n")
        (pkg_b / "pnpm-lock.yaml").write_text("b\n")
        result = detect_lockfiles(str(tmp_path))
        assert len(result["lockfiles"]) == 3
        assert result["workspace_count"] == 3

    def test_bun_lock_and_lockb_in_same_dir_is_one_workspace(self, tmp_path):
        # Both recorded (no dedup), but still ONE workspace root.
        (tmp_path / "bun.lock").write_text("text\n")
        (tmp_path / "bun.lockb").write_text("binary\n")
        result = detect_lockfiles(str(tmp_path))
        names = sorted(Path(p).name for p in result["lockfiles"])
        assert names == ["bun.lock", "bun.lockb"]
        assert result["workspace_count"] == 1

    def test_node_modules_is_ignored(self, tmp_path):
        (tmp_path / "package-lock.json").write_text("root\n")
        nm = tmp_path / "node_modules" / "dep"
        nm.mkdir(parents=True)
        (nm / "package-lock.json").write_text("nested-dep\n")
        result = detect_lockfiles(str(tmp_path))
        # Only the root lockfile is counted; node_modules is pruned.
        assert len(result["lockfiles"]) == 1
        assert result["workspace_count"] == 1

    def test_dot_git_is_ignored(self, tmp_path):
        (tmp_path / "yarn.lock").write_text("root\n")
        gitdir = tmp_path / ".git" / "weird"
        gitdir.mkdir(parents=True)
        (gitdir / "package-lock.json").write_text("noise\n")
        result = detect_lockfiles(str(tmp_path))
        assert len(result["lockfiles"]) == 1

    def test_nonexistent_or_file_target_degrades_gracefully(self, tmp_path):
        missing = tmp_path / "nope"
        assert detect_lockfiles(str(missing)) == {"lockfiles": [], "workspace_count": 1}
        f = tmp_path / "a.txt"
        f.write_text("x")
        assert detect_lockfiles(str(f)) == {"lockfiles": [], "workspace_count": 1}

    def test_empty_and_non_str_targets(self):
        assert detect_lockfiles("") == {"lockfiles": [], "workspace_count": 1}
        assert detect_lockfiles(None) == {"lockfiles": [], "workspace_count": 1}

    def test_walk_is_depth_bounded(self, tmp_path):
        # A lockfile buried deeper than the depth bound is NOT descended into,
        # so the walk stays bounded (no crash, graceful).
        deep = tmp_path
        for i in range(20):
            deep = deep / f"lvl{i}"
        deep.mkdir(parents=True)
        (deep / "yarn.lock").write_text("deep\n")
        # A shallow lockfile is still found.
        (tmp_path / "package-lock.json").write_text("root\n")
        result = detect_lockfiles(str(tmp_path))
        names = [Path(p).name for p in result["lockfiles"]]
        assert "package-lock.json" in names
        assert "yarn.lock" not in names  # pruned by depth bound
