"""Dirty worktree state/mode/byte preservation and pre-write scope denial."""

import os
import subprocess

import pytest

from orchestration.scope_preservation import (
    ScopePolicy,
    ScopeViolation,
    capture_preservation_artifact,
    compare_preservation_artifact,
    out_of_scope_dirty_paths,
)


def _git(root, *args):
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True)


@pytest.fixture
def dirty_repo(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init")
    _git(root, "config", "user.email", "test@example.invalid")
    _git(root, "config", "user.name", "Test")
    (root / "in.txt").write_text("before\n")
    (root / "outside.txt").write_text("outside\n")
    (root / "deleted.txt").write_text("delete me\n")
    _git(root, "add", ".")
    _git(root, "commit", "-m", "initial")
    (root / "in.txt").write_text("planned dirty\n")
    (root / "outside.txt").write_text("pre-existing outside dirty\n")
    (root / "deleted.txt").unlink()
    (root / "untracked.bin").write_bytes(b"\x00outside-untracked\xff")
    os.chmod(root / "outside.txt", 0o600)
    return root


def test_pre_post_artifact_proves_path_git_state_mode_digest_and_direct_bytes(dirty_repo, tmp_path):
    artifact = tmp_path / "preservation"
    captured = capture_preservation_artifact(dirty_repo, artifact)
    assert {record["path"] for record in captured["paths"]} == {
        "deleted.txt",
        "in.txt",
        "outside.txt",
        "untracked.bin",
    }
    outside = next(record for record in captured["paths"] if record["path"] == "outside.txt")
    assert outside["tracked"] is True
    assert outside["worktree_status"] == "M"
    assert outside["mode"] == "0600"
    assert outside["sha256"]
    assert compare_preservation_artifact(dirty_repo, artifact) == []

    (dirty_repo / "outside.txt").write_text("changed after capture\n")
    failures = compare_preservation_artifact(dirty_repo, artifact)
    assert any("direct byte comparison failed" in failure for failure in failures)
    assert any("SHA-256 changed" in failure for failure in failures)


def test_out_of_scope_capture_excludes_dirty_paths_selected_for_implementation(
    dirty_repo, tmp_path
):
    manifest = {
        "schema_version": 1,
        "manifest_id": "test",
        "version": 1,
        "in_scope_tracked_paths": ["in.txt"],
        "writable_paths": ["in.txt"],
        "leak_patterns": [],
        "leak_fixtures": [],
        "allowed_generic_cases": [],
        "ignored_runtime_outputs": [],
        "out_of_scope_reporting_boundary": "everything else is report-only",
    }
    selected = out_of_scope_dirty_paths(dirty_repo, manifest)
    assert selected == ["deleted.txt", "outside.txt", "untracked.bin"]
    artifact = tmp_path / "out-of-scope-preservation"
    captured = capture_preservation_artifact(dirty_repo, artifact, include_paths=selected)
    assert {record["path"] for record in captured["paths"]} == set(selected)

    (dirty_repo / "in.txt").write_text("implementation is allowed to change this\n")
    assert compare_preservation_artifact(dirty_repo, artifact) == []


def test_preservation_artifact_rejects_tampered_manifest(dirty_repo, tmp_path):
    artifact = tmp_path / "preservation"
    capture_preservation_artifact(dirty_repo, artifact)
    artifact_path = artifact / "artifact.json"
    payload = artifact_path.read_text()
    artifact_path.write_text(payload.replace('"head": "', '"head": "tampered-'))
    errors = compare_preservation_artifact(dirty_repo, artifact)
    assert "preservation artifact revision changed" in errors
    assert "preservation artifact digest is invalid or tampered" in errors


def test_out_of_scope_transient_write_is_denied_before_side_effect(dirty_repo, tmp_path):
    manifest = {
        "schema_version": 1,
        "manifest_id": "test",
        "version": 1,
        "in_scope_tracked_paths": ["in.txt"],
        "writable_paths": ["in.txt"],
        "leak_patterns": [],
        "leak_fixtures": [],
        "allowed_generic_cases": [],
        "ignored_runtime_outputs": [".cache/**"],
        "out_of_scope_reporting_boundary": "everything else is report-only",
    }
    policy = ScopePolicy.from_manifest(dirty_repo, manifest)
    before = (dirty_repo / "outside.txt").read_bytes()
    with pytest.raises(ScopeViolation, match="outside selected writable scope"):
        policy.authorize("outside.txt")
    assert (dirty_repo / "outside.txt").read_bytes() == before
    assert policy.authorize("in.txt") == (dirty_repo / "in.txt").resolve()

    outside = tmp_path / "outside-dir"
    outside.mkdir()
    (dirty_repo / "escape").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ScopeViolation, match="escapes"):
        policy.authorize("escape/new.txt")


@pytest.mark.parametrize(
    "argv",
    [
        ["git", "reset", "--hard"],
        ["git", "checkout", "--", "outside.txt"],
        ["git", "clean", "-fd"],
        ["git", "add", "."],
        ["rm", "-rf", "outside"],
    ],
)
def test_product_mutation_fence_rejects_destructive_commands(argv):
    with pytest.raises(ScopeViolation):
        ScopePolicy.authorize_argv(argv)
