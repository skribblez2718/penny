"""
Unit tests for sca provisioning.py (Phase 3).

Covers the supply-chain-integrity primitives:

  - compute_sha256(path) -> deterministic, correct hex digest.
  - verify_or_lock(tool, path, *, confirmed) -> Trust-On-First-Use lock:
      * a first-ever tool with NO prior lock BLOCKS unless confirmed=True;
      * confirmed=True records the freshly-computed hash and succeeds;
      * a later run whose hash MISMATCHES the lock BLOCKS (never warns);
      * calling twice with confirmed=True is idempotent (verify, no double-write).
  - check_tool_installed / check_required_tools / check_optional_tools with an
    injectable which_fn so tests never touch the real PATH.

CRITICAL: no real tool hash is ever hardcoded here. Every expected hash is
computed at test time with hashlib from bytes this test itself wrote to
tmp_path, so the assertions are genuinely correct, not guessed. No network,
no real subprocess, no real PATH lookups anywhere in this file.
"""

import hashlib
import json
import os
import stat
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import provisioning as prov  # noqa: E402
from provisioning import (  # noqa: E402
    compute_sha256,
    verify_or_lock,
    check_tool_installed,
    check_required_tools,
    check_optional_tools,
    ToolStatus,
    VerifyResult,
)
from tool_manifest import required_tools, optional_tools, UnknownToolError  # noqa: E402


# ── Helpers ──────────────────────────────────────────────────────────────


def _write_bytes(path: Path, data: bytes) -> str:
    """Write ``data`` to ``path`` and return its true SHA256 (via hashlib)."""
    path.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def _make_executable(path: Path, data: bytes = b"#!/bin/sh\nexit 0\n") -> Path:
    path.write_bytes(data)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


# ── compute_sha256 ───────────────────────────────────────────────────────


class TestComputeSha256:
    def test_matches_hashlib_for_known_bytes(self, tmp_path):
        f = tmp_path / "fixture.bin"
        expected = _write_bytes(f, b"sca-phase3-fixture-bytes\n")
        assert compute_sha256(f) == expected

    def test_deterministic_across_calls(self, tmp_path):
        f = tmp_path / "a.bin"
        _write_bytes(f, b"repeatable")
        assert compute_sha256(f) == compute_sha256(f)

    def test_empty_file_hash(self, tmp_path):
        f = tmp_path / "empty.bin"
        expected = _write_bytes(f, b"")
        assert compute_sha256(f) == expected
        # sanity: known SHA256 of the empty byte string
        assert expected == hashlib.sha256(b"").hexdigest()

    def test_accepts_str_and_path(self, tmp_path):
        f = tmp_path / "b.bin"
        expected = _write_bytes(f, b"str-or-path")
        assert compute_sha256(str(f)) == expected
        assert compute_sha256(f) == expected

    def test_missing_file_raises(self, tmp_path):
        with pytest.raises((FileNotFoundError, OSError)):
            compute_sha256(tmp_path / "nope.bin")


# ── verify_or_lock: Trust-On-First-Use ───────────────────────────────────


class TestVerifyOrLock:
    def test_first_time_unconfirmed_blocks(self, tmp_path):
        binp = tmp_path / "osv-scanner"
        _write_bytes(binp, b"fake-osv-binary")
        lock = tmp_path / "tool-lock.json"

        res = verify_or_lock(
            "osv-scanner", binp, confirmed=False, lockfile_path=lock
        )
        assert isinstance(res, VerifyResult)
        assert res.ok is False
        assert res.status == "blocked_unconfirmed"
        # Nothing was written — a blocked, unconfirmed tool never touches lock.
        assert not lock.exists()

    def test_first_time_confirmed_locks(self, tmp_path):
        binp = tmp_path / "gitleaks"
        expected = _write_bytes(binp, b"fake-gitleaks-binary")
        lock = tmp_path / "tool-lock.json"

        res = verify_or_lock("gitleaks", binp, confirmed=True, lockfile_path=lock)
        assert res.ok is True
        assert res.status == "locked"
        assert res.sha256 == expected

        data = json.loads(lock.read_text())
        assert data["tools"]["gitleaks"]["sha256"] == expected
        # Lockfile stores metadata only — never binary bytes.
        assert "bytes" not in data["tools"]["gitleaks"]

    def test_matching_hash_verifies(self, tmp_path):
        binp = tmp_path / "trivy"
        _write_bytes(binp, b"trivy-bytes")
        lock = tmp_path / "tool-lock.json"
        verify_or_lock("trivy", binp, confirmed=True, lockfile_path=lock)

        # Second run, same bytes -> verified (no confirm needed).
        res = verify_or_lock("trivy", binp, confirmed=False, lockfile_path=lock)
        assert res.ok is True
        assert res.status == "verified"

    def test_mismatch_blocks_never_warns(self, tmp_path):
        binp = tmp_path / "semgrep"
        _write_bytes(binp, b"good-bytes")
        lock = tmp_path / "tool-lock.json"
        verify_or_lock("semgrep", binp, confirmed=True, lockfile_path=lock)
        locked_hash = json.loads(lock.read_text())["tools"]["semgrep"]["sha256"]

        # Binary swapped underneath us (tamper / substitution).
        binp.write_bytes(b"tampered-bytes")
        res = verify_or_lock(
            "semgrep", binp, confirmed=True, lockfile_path=lock
        )
        assert res.ok is False
        assert res.status == "blocked_mismatch"
        # The existing lock entry is NOT overwritten by a mismatch.
        assert json.loads(lock.read_text())["tools"]["semgrep"]["sha256"] == locked_hash

    def test_confirmed_twice_is_idempotent(self, tmp_path):
        binp = tmp_path / "gitleaks"
        _write_bytes(binp, b"stable-bytes")
        lock = tmp_path / "tool-lock.json"

        r1 = verify_or_lock("gitleaks", binp, confirmed=True, lockfile_path=lock)
        assert r1.status == "locked"
        before = lock.read_text()

        r2 = verify_or_lock("gitleaks", binp, confirmed=True, lockfile_path=lock)
        assert r2.ok is True
        assert r2.status == "verified"  # not re-locked / double-written
        # Idempotent: file content unchanged apart from being re-parseable JSON.
        assert json.loads(lock.read_text()) == json.loads(before)

    def test_missing_binary_blocks(self, tmp_path):
        lock = tmp_path / "tool-lock.json"
        res = verify_or_lock(
            "gitleaks", tmp_path / "not-here", confirmed=True, lockfile_path=lock
        )
        assert res.ok is False
        assert res.status == "blocked_missing_binary"
        assert not lock.exists()

    def test_missing_lockfile_treated_as_no_entries(self, tmp_path):
        # Fresh checkout: lockfile does not exist yet -> not an error.
        binp = tmp_path / "gitleaks"
        _write_bytes(binp, b"x")
        lock = tmp_path / "subdir" / "tool-lock.json"  # parent doesn't exist
        res = verify_or_lock("gitleaks", binp, confirmed=False, lockfile_path=lock)
        assert res.ok is False
        assert res.status == "blocked_unconfirmed"  # no crash

    def test_corrupt_lockfile_not_trusted(self, tmp_path):
        # Malformed JSON must not crash and must not be trusted as 'verified'.
        binp = tmp_path / "gitleaks"
        _write_bytes(binp, b"x")
        lock = tmp_path / "tool-lock.json"
        lock.write_text("{not-valid-json")

        # confirmed=False -> behaves as 'no entries' -> blocked_unconfirmed.
        res = verify_or_lock("gitleaks", binp, confirmed=False, lockfile_path=lock)
        assert res.ok is False
        assert res.status == "blocked_unconfirmed"

    def test_wrong_shape_json_array_not_trusted(self, tmp_path):
        # Valid JSON but the WRONG shape (a JSON array, not the expected
        # dict-with-'tools'-key) must be treated as 'no entries', never trusted.
        binp = tmp_path / "gitleaks"
        _write_bytes(binp, b"x")
        lock = tmp_path / "tool-lock.json"
        lock.write_text("[1, 2, 3]")
        res = verify_or_lock("gitleaks", binp, confirmed=False, lockfile_path=lock)
        assert res.ok is False
        assert res.status == "blocked_unconfirmed"

    def test_wrong_shape_dict_without_tools_key_not_trusted(self, tmp_path):
        # Valid JSON dict but missing the 'tools' key (or wrong type for it)
        # -> treated as 'no entries', never silently trusted.
        binp = tmp_path / "gitleaks"
        _write_bytes(binp, b"x")
        lock = tmp_path / "tool-lock.json"
        lock.write_text('{"tools": ["not", "a", "dict"]}')
        res = verify_or_lock("gitleaks", binp, confirmed=False, lockfile_path=lock)
        assert res.ok is False
        assert res.status == "blocked_unconfirmed"

    def test_multiple_tools_coexist_in_one_lock(self, tmp_path):
        lock = tmp_path / "tool-lock.json"
        a = tmp_path / "gitleaks"
        b = tmp_path / "trivy"
        _write_bytes(a, b"aaa")
        _write_bytes(b, b"bbb")
        verify_or_lock("gitleaks", a, confirmed=True, lockfile_path=lock)
        verify_or_lock("trivy", b, confirmed=True, lockfile_path=lock)
        tools = json.loads(lock.read_text())["tools"]
        assert set(tools) == {"gitleaks", "trivy"}


# ── check_tool_installed ─────────────────────────────────────────────────


class TestCheckToolInstalled:
    def test_installed_when_which_returns_real_executable(self, tmp_path):
        exe = _make_executable(tmp_path / "gitleaks")

        def fake_which(_binary):
            return str(exe)

        status = check_tool_installed("gitleaks", which_fn=fake_which)
        assert isinstance(status, ToolStatus)
        assert status.installed is True
        assert status.path == str(exe)
        # No subprocess invoked -> version not verified in this phase.
        assert status.version_verified is False

    def test_not_installed_when_which_returns_none(self):
        status = check_tool_installed("gitleaks", which_fn=lambda _b: None)
        assert status.installed is False
        assert status.path is None

    def test_which_path_that_does_not_exist_is_not_installed(self, tmp_path):
        # which_fn lies: returns a path with no file behind it.
        ghost = str(tmp_path / "ghost-binary")
        status = check_tool_installed("gitleaks", which_fn=lambda _b: ghost)
        assert status.installed is False

    def test_uses_binary_name_not_tool_name(self, tmp_path):
        # retire.js resolves to the 'retire' binary.
        seen = {}

        def fake_which(binary):
            seen["binary"] = binary
            return None

        check_tool_installed("retire.js", which_fn=fake_which)
        assert seen["binary"] == "retire"

    def test_unknown_tool_raises(self):
        with pytest.raises(UnknownToolError):
            check_tool_installed("nope", which_fn=lambda _b: None)


# ── check_required_tools ─────────────────────────────────────────────────


class TestCheckRequiredTools:
    def test_all_present_returns_ok(self, tmp_path):
        exe = _make_executable(tmp_path / "bin")
        ok, missing = check_required_tools(which_fn=lambda _b: str(exe))
        assert ok is True
        assert missing == []

    def test_missing_required_blocks(self):
        # Nothing on PATH -> every required tool missing -> ok=False.
        ok, missing = check_required_tools(which_fn=lambda _b: None)
        assert ok is False
        assert set(missing) == {s.name for s in required_tools()}

    def test_partial_missing_lists_only_absent(self, tmp_path):
        exe = _make_executable(tmp_path / "bin")

        def fake_which(binary):
            # gitleaks present, others absent.
            return str(exe) if binary == "gitleaks" else None

        ok, missing = check_required_tools(which_fn=fake_which)
        assert ok is False
        assert "gitleaks" not in missing
        assert "osv-scanner" in missing and "semgrep" in missing


# ── check_optional_tools ─────────────────────────────────────────────────


class TestCheckOptionalTools:
    def test_missing_optional_is_degraded_not_blocking(self):
        rows = check_optional_tools(which_fn=lambda _b: None)
        assert isinstance(rows, list)
        names = {r["tool"] for r in rows}
        assert names == {s.name for s in optional_tools()}
        for r in rows:
            assert r["installed"] is False
            assert r["degraded"] is True
            assert r["note"]  # human-readable degradation note

    def test_present_optional_not_degraded(self, tmp_path):
        exe = _make_executable(tmp_path / "bin")
        rows = check_optional_tools(which_fn=lambda _b: str(exe))
        for r in rows:
            assert r["installed"] is True
            assert r["degraded"] is False


# ── fast-lane discipline (no subprocess) ─────────────────────────────────


class TestNoSubprocess:
    def test_provisioning_module_imports_no_subprocess(self):
        text = (Path(prov.__file__)).read_text(encoding="utf-8")
        assert "subprocess" not in text


# ── DEFAULT_LOCKFILE pollution guardrail (docstring warning) ──────────────


class TestLockfilePollutionWarning:
    def test_default_lockfile_resolves_inside_skill_tree(self):
        # Documents the design smell: the default resolves into the real skill
        # tree, so tests/manual verification MUST override lockfile_path.
        assert prov.DEFAULT_LOCKFILE.name == "tool-lock.json"
        assert prov.DEFAULT_LOCKFILE.parent.name == "sca"

    def test_default_lockfile_carries_prominent_warning(self):
        # A loud, discoverable warning must exist in the module so a future dev
        # does not accidentally pollute real skill state during verification.
        text = (Path(prov.__file__)).read_text(encoding="utf-8")
        assert "WARNING" in text
        assert "explicit lockfile_path override" in text

    def test_verify_or_lock_docstring_warns_about_override(self):
        assert verify_or_lock.__doc__ is not None
        assert "lockfile_path" in verify_or_lock.__doc__
        assert "WARNING" in verify_or_lock.__doc__
