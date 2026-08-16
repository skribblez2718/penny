"""Storage, integrity, recovery, and read tests for the artifact plane."""

import json
import logging
import os
import sqlite3
import stat
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import orchestration.artifacts as artifact_module
from orchestration.artifacts import (
    ArtifactDivergenceError,
    ArtifactIntegrityError,
    ArtifactNotFoundError,
    ArtifactPathError,
    ArtifactStore,
    ArtifactValidationError,
    KIND_AGENT_OUTPUT,
)

CONTENT = "alpha βeta\nfinal line\n".encode()


def _put(store, **overrides):
    values = {
        "run_id": "run-1",
        "phase": "observing",
        "kind": KIND_AGENT_OUTPUT,
        "operation_id": "observe-1",
        "version": 1,
        "producer": "agent:echo",
        "consumer_scope": ["state:synthesizing"],
        "media_type": "text/plain; charset=utf-8",
    }
    values.update(overrides)
    return store.put(CONTENT, **values)


def _object_path(store, ref):
    return store.root / "objects" / "sha256" / ref.content_digest[:2] / ref.content_digest[2:]


def _mode(path):
    return stat.S_IMODE(path.stat().st_mode)


def test_root_config_prefers_explicit_env_then_xdg_and_rejects_relative(tmp_path):
    configured = tmp_path / "configured"
    store = ArtifactStore(environ={"PENNY_ARTIFACT_ROOT": str(configured)})
    assert store.root == configured

    xdg = tmp_path / "xdg-state"
    xdg_store = ArtifactStore(environ={"XDG_STATE_HOME": str(xdg), "HOME": str(tmp_path)})
    assert xdg_store.root == xdg / "penny" / "artifacts"
    assert not (tmp_path / ".penny").exists()

    with pytest.raises(ArtifactValidationError, match="absolute"):
        ArtifactStore(environ={"PENNY_ARTIFACT_ROOT": "relative/artifacts"})

    package_child = Path(artifact_module.__file__).resolve().parent / "unsafe-artifacts"
    with pytest.raises(ArtifactPathError, match="package installation|source tree"):
        ArtifactStore(package_child)
    assert not package_child.exists()

    unrelated = tmp_path / "unrelated"
    unrelated.mkdir(mode=0o755)
    (unrelated / "keep.txt").write_text("do not claim", encoding="utf-8")
    original_mode = _mode(unrelated)
    with pytest.raises(ArtifactPathError, match="unrelated"):
        ArtifactStore(unrelated)
    assert _mode(unrelated) == original_mode
    assert (unrelated / "keep.txt").read_text(encoding="utf-8") == "do not claim"


def test_store_uses_cas_layout_owner_only_permissions_and_separate_manifest(tmp_path):
    store = ArtifactStore(tmp_path / "artifacts")
    ref = _put(store)
    object_path = _object_path(store, ref)

    assert object_path.read_bytes() == CONTENT
    assert store.manifest_path == store.root / "manifest.sqlite3"
    assert object_path.name == ref.content_digest[2:]
    assert object_path.parent.name == ref.content_digest[:2]
    assert _mode(store.root) == 0o700
    assert _mode(store.objects_root) == 0o700
    assert _mode(object_path.parent) == 0o700
    assert _mode(store.manifest_path) == 0o600
    assert _mode(object_path) == 0o600


def test_manifest_artifact_rows_are_immutable(tmp_path):
    store = ArtifactStore(tmp_path / "artifacts")
    ref = _put(store)
    connection = sqlite3.connect(store.manifest_path)
    try:
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute(
                "UPDATE artifacts SET producer = ? WHERE artifact_id = ?",
                ("agent:mallory", ref.artifact_id),
            )
        connection.rollback()
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute("DELETE FROM artifacts WHERE artifact_id = ?", (ref.artifact_id,))
        connection.rollback()
    finally:
        connection.close()
    assert store.validate(ref, expected_run_id="run-1").ref == ref


def test_identical_operation_retry_is_idempotent_and_divergence_fails(tmp_path):
    store = ArtifactStore(tmp_path / "artifacts")
    first = _put(store)
    second = _put(store)
    assert second == first

    with pytest.raises(ArtifactDivergenceError, match="divergent"):
        store.put(
            b"different exact bytes",
            run_id="run-1",
            phase="observing",
            kind=KIND_AGENT_OUTPUT,
            operation_id="observe-1",
            version=1,
            producer="agent:echo",
            consumer_scope=["state:synthesizing"],
            media_type="text/plain; charset=utf-8",
        )

    assert store.read_bytes(first, expected_run_id="run-1") == CONTENT


def test_version_parent_and_upstream_refs_round_trip(tmp_path):
    store = ArtifactStore(tmp_path / "artifacts")
    upstream = _put(store)
    parent = _put(
        store,
        phase="synthesizing",
        operation_id="synthesize-1",
        producer="agent:synthia",
        consumer_scope=["state:revising"],
        upstream_refs=[upstream],
    )
    child = store.put(
        b"revised synthesis",
        run_id="run-1",
        phase="synthesizing",
        kind=KIND_AGENT_OUTPUT,
        operation_id="synthesize-2",
        version=2,
        producer="agent:synthia",
        consumer_scope=["state:revising"],
        media_type="text/plain; charset=utf-8",
        parent_ref=parent,
        upstream_refs=[upstream],
    )

    envelope = store.validate(child, expected_run_id="run-1")
    assert envelope.parent_ref == parent
    assert envelope.upstream_refs == (upstream,)

    with pytest.raises(ArtifactValidationError, match="require a parent"):
        store.put(
            b"orphan revision",
            run_id="run-1",
            phase="synthesizing",
            kind=KIND_AGENT_OUTPUT,
            operation_id="orphan",
            version=2,
            producer="agent:synthia",
            consumer_scope=["state:revising"],
            media_type="text/plain",
        )

    other_run = store.put(
        b"other run",
        run_id="run-2",
        phase="observing",
        kind=KIND_AGENT_OUTPUT,
        operation_id="other-run",
        version=1,
        producer="agent:echo",
        consumer_scope=["state:synthesizing"],
        media_type="text/plain",
    )
    with pytest.raises(ArtifactValidationError, match="same run"):
        store.put(
            b"cross-run lineage",
            run_id="run-1",
            phase="planning",
            kind=KIND_AGENT_OUTPUT,
            operation_id="cross-run",
            version=1,
            producer="agent:piper",
            consumer_scope=["state:acting"],
            media_type="text/plain",
            upstream_refs=[other_run],
        )


def test_exact_validation_rejects_wrong_context_and_consumer(tmp_path):
    store = ArtifactStore(tmp_path / "artifacts")
    ref = _put(store)
    cases = [
        ({"expected_run_id": "run-2"}, "wrong run"),
        (
            {"expected_run_id": "run-1", "expected_phase": "planning"},
            "wrong phase",
        ),
        (
            {"expected_run_id": "run-1", "expected_producer": "agent:annie"},
            "wrong producer",
        ),
        (
            {"expected_run_id": "run-1", "consumer": "state:publishing"},
            "does not grant",
        ),
    ]
    for kwargs, message in cases:
        with pytest.raises(ArtifactValidationError, match=message):
            store.validate(ref, **kwargs)


def test_missing_and_digest_mismatched_objects_fail_closed(tmp_path):
    missing_store = ArtifactStore(tmp_path / "missing")
    missing_ref = _put(missing_store)
    _object_path(missing_store, missing_ref).unlink()
    with pytest.raises(ArtifactNotFoundError):
        missing_store.validate(missing_ref, expected_run_id="run-1")

    corrupt_store = ArtifactStore(tmp_path / "corrupt")
    corrupt_ref = _put(corrupt_store)
    object_path = _object_path(corrupt_store, corrupt_ref)
    object_path.write_bytes(b"x" * len(CONTENT))
    object_path.chmod(0o600)
    with pytest.raises(ArtifactIntegrityError, match="digest mismatch"):
        corrupt_store.validate(corrupt_ref, expected_run_id="run-1")


def test_ranged_reads_are_exact_bytes_and_validate_bounds(tmp_path):
    store = ArtifactStore(tmp_path / "artifacts")
    ref = _put(store)
    beta_start = CONTENT.index("β".encode())
    beta_end = beta_start + len("β".encode())
    assert (
        store.read_range(
            ref,
            expected_run_id="run-1",
            start=beta_start,
            end=beta_end,
            consumer="state:synthesizing",
        )
        == "β".encode()
    )
    assert (
        store.read_range(ref, expected_run_id="run-1", start=len(CONTENT), end=len(CONTENT)) == b""
    )
    with pytest.raises(ArtifactValidationError, match="outside"):
        store.read_range(ref, expected_run_id="run-1", start=0, end=len(CONTENT) + 1)


def test_materialization_is_owner_only_ranged_and_explicitly_cleaned(tmp_path):
    store = ArtifactStore(tmp_path / "artifacts")
    ref = _put(store)
    materialized = store.materialize(
        ref,
        expected_run_id="run-1",
        start=0,
        end=5,
        ttl_seconds=1,
        consumer="state:synthesizing",
    )
    assert materialized.path.parent == store.materializations_root
    assert materialized.path.read_bytes() == b"alpha"
    assert _mode(materialized.path) == 0o600
    assert store.release_materialization(materialized.materialization_id)
    assert not materialized.path.exists()
    assert not store.release_materialization(materialized.materialization_id)

    expired = store.materialize(ref, expected_run_id="run-1", ttl_seconds=1)
    removed = store.cleanup_expired(now=datetime.now(timezone.utc) + timedelta(seconds=2))
    assert removed == 1
    assert not expired.path.exists()
    assert store.read_bytes(ref, expected_run_id="run-1") == CONTENT


def test_root_and_managed_symlinks_are_refused_without_escape(tmp_path):
    external = tmp_path / "external"
    external.mkdir()
    root_link = tmp_path / "root-link"
    root_link.symlink_to(external, target_is_directory=True)
    with pytest.raises(ArtifactPathError, match="root cannot be a symlink"):
        ArtifactStore(root_link)

    store = ArtifactStore(tmp_path / "artifacts")
    store.objects_root.rename(tmp_path / "detached-objects")
    store.objects_root.symlink_to(external, target_is_directory=True)
    with pytest.raises(ArtifactPathError, match="cannot be a symlink"):
        _put(store)
    assert list(external.iterdir()) == []


def test_preexisting_object_symlink_is_refused_not_followed(tmp_path):
    store = ArtifactStore(tmp_path / "artifacts")
    digest = artifact_module.sha256_digest(CONTENT)
    shard = store.sha256_root / digest[:2]
    shard.mkdir(mode=0o700)
    outside = tmp_path / "outside.txt"
    outside.write_bytes(b"do not replace")
    (shard / digest[2:]).symlink_to(outside)

    with pytest.raises(ArtifactPathError, match="cannot be a symlink"):
        _put(store)
    assert outside.read_bytes() == b"do not replace"


def test_object_and_manifest_directory_fsyncs_are_requested(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(artifact_module, "_fsync_directory", lambda path: calls.append(path))
    store = ArtifactStore(tmp_path / "artifacts")
    calls.clear()
    ref = _put(store)

    assert store.root in calls
    assert _object_path(store, ref).parent in calls


def test_logs_are_metadata_only_and_never_contain_payload(tmp_path, caplog):
    secret_content = b"PRIVATE-PAYLOAD-SHOULD-NOT-APPEAR"
    store = ArtifactStore(tmp_path / "artifacts")
    with caplog.at_level(logging.INFO, logger="orchestration.artifacts"):
        ref = store.put(
            secret_content,
            run_id="run-1",
            phase="observing",
            kind=KIND_AGENT_OUTPUT,
            operation_id="secret-output",
            version=1,
            producer="agent:echo",
            consumer_scope=["state:synthesizing"],
            media_type="application/octet-stream",
        )
        assert store.read_bytes(ref, expected_run_id="run-1") == secret_content

    rendered_records = "\n".join(repr(record.__dict__) for record in caplog.records)
    assert secret_content.decode() not in rendered_records
    assert {record.artifact_event for record in caplog.records} == {"stored", "read"}
    assert all(hasattr(record, "content_digest") for record in caplog.records)


def test_fresh_process_recovers_manifest_selection_and_exact_bytes(tmp_path):
    store = ArtifactStore(tmp_path / "artifacts")
    ref = _put(store)
    store.select(ref, expected=None)
    script = """
import json
import sys
from orchestration.artifacts import ArtifactRef, ArtifactStore
store = ArtifactStore(sys.argv[1])
ref = ArtifactRef.from_dict(json.loads(sys.argv[2]))
selected = store.get_selected(run_id='run-1', phase='observing', kind='agent-output')
assert selected == ref
sys.stdout.buffer.write(store.read_bytes(ref, expected_run_id='run-1', require_selected=True))
"""
    result = subprocess.run(
        [sys.executable, "-c", script, str(store.root), json.dumps(ref.to_dict())],
        check=False,
        capture_output=True,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    assert result.returncode == 0, result.stderr.decode()
    assert result.stdout == CONTENT
