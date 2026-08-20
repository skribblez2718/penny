"""Generic public-boundary scanner behavior on synthetic repositories."""

import hashlib
import importlib.util
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCANNER = ROOT / "scripts/system/checks/check_public_boundary.py"


def _scanner():
    spec = importlib.util.spec_from_file_location("test_public_boundary", SCANNER)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _git(root, *args):
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)


def test_out_of_scope_match_is_reported_without_a_write(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init")
    _git(root, "config", "user.email", "test@example.invalid")
    _git(root, "config", "user.name", "Test")
    (root / "inside.txt").write_text("clean\n")
    outside = root / "outside.txt"
    outside.write_text("private downstream-marker value\n")
    _git(root, "add", ".")
    _git(root, "commit", "-m", "initial")
    manifest = {
        "schema_version": 1,
        "manifest_id": "fixture",
        "version": 1,
        "in_scope_tracked_paths": ["inside.txt"],
        "writable_paths": ["inside.txt"],
        "leak_patterns": [
            {"id": "downstream", "pattern_parts": ["downstream", "-marker"], "reason": "fixture"}
        ],
        "leak_fixtures": [],
        "allowed_generic_cases": [],
        "ignored_runtime_outputs": [],
        "out_of_scope_reporting_boundary": "outside is report-only",
    }
    before = hashlib.sha256(outside.read_bytes()).hexdigest()
    matches = _scanner().scan_manifest(root, manifest)
    assert len(matches) == 1 and matches[0].in_scope is False
    assert hashlib.sha256(outside.read_bytes()).hexdigest() == before
    assert (
        subprocess.run(
            ["git", "status", "--porcelain"], cwd=root, check=True, capture_output=True, text=True
        ).stdout
        == ""
    )


def test_selected_untracked_file_is_scanned_fail_closed(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init")
    untracked = root / "new.py"
    untracked.write_text("private operator-marker value\n")
    manifest = {
        "schema_version": 1,
        "manifest_id": "fixture",
        "version": 1,
        "in_scope_tracked_paths": ["*.py"],
        "writable_paths": ["*.py"],
        "leak_patterns": [
            {"id": "operator", "pattern_parts": ["operator", "-marker"], "reason": "fixture"}
        ],
        "leak_fixtures": [],
        "allowed_generic_cases": [],
        "ignored_runtime_outputs": [],
        "out_of_scope_reporting_boundary": "tracked files outside selection",
    }
    matches = _scanner().scan_manifest(root, manifest)
    assert [(match.path, match.in_scope) for match in matches] == [("new.py", True)]


def test_repository_wide_scope_scans_nested_nonignored_untracked_file(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init")
    nested = root / "new" / "deep" / "private.txt"
    nested.parent.mkdir(parents=True)
    nested.write_text("private operator-marker value\n")
    manifest = {
        "schema_version": 1,
        "manifest_id": "fixture",
        "version": 1,
        "in_scope_tracked_paths": ["**"],
        "writable_paths": ["**"],
        "leak_patterns": [
            {"id": "operator", "pattern_parts": ["operator", "-marker"], "reason": "fixture"}
        ],
        "leak_fixtures": [],
        "allowed_generic_cases": [],
        "ignored_runtime_outputs": [],
        "out_of_scope_reporting_boundary": "none",
    }
    matches = _scanner().scan_manifest(root, manifest)
    assert [(match.path, match.in_scope) for match in matches] == [("new/deep/private.txt", True)]


def test_generic_match_requires_manifest_authorized_source_evidence(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init")
    _git(root, "config", "user.email", "test@example.invalid")
    _git(root, "config", "user.name", "Test")
    (root / "inside.txt").write_text("synthetic operator-marker fixture\n")
    _git(root, "add", ".")
    _git(root, "commit", "-m", "initial")
    manifest = {
        "schema_version": 1,
        "manifest_id": "fixture",
        "version": 1,
        "in_scope_tracked_paths": ["inside.txt"],
        "writable_paths": ["inside.txt"],
        "leak_patterns": [
            {"id": "operator", "pattern_parts": ["operator", "-marker"], "reason": "fixture"}
        ],
        "leak_fixtures": [],
        "allowed_generic_cases": [],
        "ignored_runtime_outputs": [],
        "out_of_scope_reporting_boundary": "outside only",
    }
    first = _scanner().scan_manifest(root, manifest)
    assert first[0].resolved_generic is False
    manifest["allowed_generic_cases"] = [
        {
            "path": "inside.txt",
            "pattern_id": "operator",
            "source_evidence": "Synthetic scanner fixture, not an operator path.",
        }
    ]
    assert _scanner().scan_manifest(root, manifest)[0].resolved_generic is True
