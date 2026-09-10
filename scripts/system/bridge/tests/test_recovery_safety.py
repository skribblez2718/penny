"""Adversarial descriptor/race/resource tests for offline recovery."""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

import scripts.system.bridge.recovery_safety as recovery_safety
from scripts.system.bridge.recovery_safety import (
    RecoveryAttempt,
    RecoveryBudget,
    RecoveryLimits,
    RecoveryRefusal,
    RecoveryRefusalCode,
    RecoverySource,
    RecoverySwapError,
    SourceSnapshot,
    VerificationResult,
    _record_attempt_event,
    _rename_no_replace_at,
    allocate_recovery_attempt,
    assert_source_unchanged,
    copy_preserved_entries,
    open_authorized_recovery,
    recovery_attempt_binding,
    snapshot_source_tree,
    swap_staged_palace,
)
from scripts.system.memory.common import ValidationError


def _receipt(root: Path, source: Path, name: str = "recovery-safety") -> Path:
    receipt = root / f"{name}-receipt.json"
    receipt.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "receipt_type": "memory-offline-access",
                "target_kind": "copied-offline",
                "target_path": str(source),
                "source_id": name,
                "authority_timestamp": "2026-09-09T12:00:00Z",
                "approved_by": "pytest",
                "checks": {
                    "drain_complete": True,
                    "hub_stopped": True,
                    "peer_processes_stopped": True,
                    "target_is_copy": True,
                },
            }
        ),
        encoding="utf-8",
    )
    receipt.chmod(0o600)
    return receipt


def _source(root: Path, name: str = "copied-palace") -> Path:
    source = root / name
    source.mkdir(mode=0o700)
    (source / "original.txt").write_text("original", encoding="utf-8")
    return source


@contextmanager
def _opened_source(
    root: Path,
    *,
    budget: RecoveryBudget | None = None,
    source: Path | None = None,
) -> Iterator[RecoverySource]:
    target = source if source is not None else _source(root)
    with open_authorized_recovery(
        target,
        _receipt(root, target),
        budget=budget,
    ) as held:
        yield held


def _allocate(source: RecoverySource, snapshot: SourceSnapshot) -> RecoveryAttempt:
    return allocate_recovery_attempt(
        source,
        "exact-rebuild",
        snapshot,
        recovery_attempt_binding(source, snapshot),
    )


def _write_at(directory_fd: int, name: str, content: bytes) -> None:
    descriptor = os.open(
        name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
        dir_fd=directory_fd,
    )
    try:
        os.write(descriptor, content)
    finally:
        os.close(descriptor)


def _object_identity(path: Path) -> tuple[int, int]:
    value = path.stat()
    return value.st_dev, value.st_ino


def test_two_attempts_and_preexisting_sentinel_are_preserved(tmp_path: Path) -> None:
    source_path = _source(tmp_path)
    old_attempt = tmp_path / "copied-palace.rebuilt"
    old_attempt.mkdir()
    sentinel = old_attempt / "sentinel"
    sentinel.write_text("keep", encoding="utf-8")
    with _opened_source(tmp_path, source=source_path) as source:
        snapshot = snapshot_source_tree(source)
        first = _allocate(source, snapshot)
        second = _allocate(source, snapshot)
        try:
            assert first.root != second.root
            assert first.root.is_dir() and second.root.is_dir()
            assert sentinel.read_text(encoding="utf-8") == "keep"
            event_path = next(first.root.glob("event-allocated-*.json"))
            event = json.loads(event_path.read_text(encoding="utf-8"))
            assert event["source_manifest_sha256"] == snapshot.manifest_sha256
        finally:
            first.close()
            second.close()


def test_snapshot_rejects_byte_drift(tmp_path: Path) -> None:
    with _opened_source(tmp_path) as source:
        snapshot = snapshot_source_tree(source)
        (source.target / "original.txt").write_text("changed", encoding="utf-8")
        with pytest.raises(ValidationError, match="source changed"):
            assert_source_unchanged(source, snapshot)


def test_snapshot_rejects_symlink_without_reading_outside(tmp_path: Path) -> None:
    source_path = _source(tmp_path)
    outside = tmp_path / "outside"
    outside.write_text("must not be read", encoding="utf-8")
    (source_path / "linked").symlink_to(outside)
    with _opened_source(tmp_path, source=source_path) as source:
        with pytest.raises(ValidationError, match="must not contain symlinks"):
            snapshot_source_tree(source)
    assert outside.read_text(encoding="utf-8") == "must not be read"


def test_source_file_race_never_hashes_replacement(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_path = _source(tmp_path)
    outside = tmp_path / "outside"
    outside.write_text("outside secret", encoding="utf-8")
    outside_identity = (outside.stat().st_dev, outside.stat().st_ino)
    real_open = recovery_safety._open_regular_file_at
    real_hash = recovery_safety._hash_descriptor
    hashed_outside: list[bool] = []

    def racing_open(parent: int, name: str, expected, field: str, flags: int):
        if name == "original.txt" and not (source_path / "original-old.txt").exists():
            os.rename(source_path / name, source_path / "original-old.txt")
            os.symlink(outside, source_path / name)
        return real_open(parent, name, expected, field, flags)

    def tracking_hash(descriptor: int, budget: RecoveryBudget) -> str:
        opened = os.fstat(descriptor)
        hashed_outside.append((opened.st_dev, opened.st_ino) == outside_identity)
        return real_hash(descriptor, budget)

    monkeypatch.setattr(recovery_safety, "_open_regular_file_at", racing_open)
    monkeypatch.setattr(recovery_safety, "_hash_descriptor", tracking_hash)
    with _opened_source(tmp_path, source=source_path) as source:
        with pytest.raises(ValidationError, match="changed before descriptor open"):
            snapshot_source_tree(source)
    assert True not in hashed_outside


def test_nested_directory_race_never_enumerates_outside(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_path = _source(tmp_path)
    nested = source_path / "nested"
    nested.mkdir()
    (nested / "inside.txt").write_text("inside", encoding="utf-8")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "outside.txt").write_text("must not be read", encoding="utf-8")
    outside_identity = (outside.stat().st_dev, outside.stat().st_ino)
    real_open = recovery_safety._open_directory_at
    real_list = recovery_safety._list_directory_names
    enumerated_outside: list[bool] = []

    def racing_open(parent: int, name: str, expected, field: str, flags: int):
        if name == "nested" and not (source_path / "nested-old").exists():
            os.rename(nested, source_path / "nested-old")
            os.symlink(outside, nested, target_is_directory=True)
        return real_open(parent, name, expected, field, flags)

    def tracking_list(descriptor: int, field: str) -> tuple[str, ...]:
        opened = os.fstat(descriptor)
        enumerated_outside.append((opened.st_dev, opened.st_ino) == outside_identity)
        return real_list(descriptor, field)

    monkeypatch.setattr(recovery_safety, "_open_directory_at", racing_open)
    monkeypatch.setattr(recovery_safety, "_list_directory_names", tracking_list)
    with _opened_source(tmp_path, source=source_path) as source:
        with pytest.raises(ValidationError, match="changed before descriptor open"):
            snapshot_source_tree(source)
    assert True not in enumerated_outside


def test_source_root_replacement_after_authorization_blocks_preview_snapshot(
    tmp_path: Path,
) -> None:
    source_path = _source(tmp_path)
    outside = tmp_path / "outside-root"
    outside.mkdir()
    (outside / "outside.txt").write_text("outside", encoding="utf-8")
    with _opened_source(tmp_path, source=source_path) as source:
        os.rename(source_path, tmp_path / "held-source")
        os.rename(outside, source_path)
        with pytest.raises(ValidationError, match="source (identity|name) changed"):
            snapshot_source_tree(source)
    assert (source_path / "outside.txt").read_text(encoding="utf-8") == "outside"
    assert (tmp_path / "held-source" / "original.txt").read_text() == "original"


def test_ancestor_replacement_after_authorization_blocks_snapshot_and_allocation(
    tmp_path: Path,
) -> None:
    ancestor = tmp_path / "ancestor"
    parent = ancestor / "parent"
    parent.mkdir(parents=True)
    source_path = _source(parent)
    receipt = _receipt(tmp_path, source_path)
    with open_authorized_recovery(source_path, receipt) as source:
        moved_ancestor = tmp_path / "ancestor-held"
        os.rename(ancestor, moved_ancestor)
        replacement_source = ancestor / "parent" / source_path.name
        replacement_source.mkdir(parents=True)
        (replacement_source / "outside.txt").write_text("outside", encoding="utf-8")

        with pytest.raises(ValidationError, match="ancestor changed"):
            snapshot_source_tree(source)
        assert (replacement_source / "outside.txt").read_text(encoding="utf-8") == "outside"
        assert (moved_ancestor / "parent" / source_path.name / "original.txt").is_file()
        assert not list((moved_ancestor / "parent").glob(".penny-*"))


def test_allocation_open_race_does_not_enter_replacement_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    source_path = _source(tmp_path)
    real_open = recovery_safety._open_directory_at
    raced_names: list[str] = []

    def racing_open(parent: int, name: str, expected, field: str, flags: int):
        if field == "recovery attempt root" and not raced_names:
            os.rename(tmp_path / name, tmp_path / f"{name}-held")
            os.symlink(outside, tmp_path / name, target_is_directory=True)
            raced_names.append(name)
        return real_open(parent, name, expected, field, flags)

    monkeypatch.setattr(recovery_safety, "_open_directory_at", racing_open)
    with _opened_source(tmp_path, source=source_path) as source:
        snapshot = snapshot_source_tree(source)
        with pytest.raises(ValidationError, match="changed before descriptor open"):
            _allocate(source, snapshot)
    assert raced_names
    assert list(outside.iterdir()) == []


def test_event_creation_uses_held_attempt_root_after_name_replacement(tmp_path: Path) -> None:
    with _opened_source(tmp_path) as source:
        snapshot = snapshot_source_tree(source)
        attempt = _allocate(source, snapshot)
        moved = tmp_path / f"{attempt.root.name}-held"
        os.rename(attempt.root, moved)
        attempt.root.mkdir()
        sentinel = attempt.root / "sentinel"
        sentinel.write_text("outside", encoding="utf-8")
        try:
            _record_attempt_event(attempt, "race-proof")
            assert list(attempt.root.glob("event-race-proof-*.json")) == []
            assert len(list(moved.glob("event-race-proof-*.json"))) == 1
            assert sentinel.read_text(encoding="utf-8") == "outside"
        finally:
            attempt.close()


def test_recursive_copy_file_race_does_not_copy_outside(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_path = _source(tmp_path)
    outside = tmp_path / "outside.txt"
    outside.write_text("outside secret", encoding="utf-8")
    with _opened_source(tmp_path, source=source_path) as source:
        snapshot = snapshot_source_tree(source)
        attempt = _allocate(source, snapshot)
        real_open = recovery_safety._open_regular_file_at

        def racing_open(parent: int, name: str, expected, field: str, flags: int):
            if name == "original.txt" and not (source_path / "original-old.txt").exists():
                os.rename(source_path / name, source_path / "original-old.txt")
                os.symlink(outside, source_path / name)
            return real_open(parent, name, expected, field, flags)

        monkeypatch.setattr(recovery_safety, "_open_regular_file_at", racing_open)
        try:
            with pytest.raises(ValidationError):
                copy_preserved_entries(
                    source,
                    attempt,
                    snapshot,
                    excluded_names=frozenset(),
                )
            assert not (attempt.staging_handle.access_path / "outside.txt").exists()
        finally:
            attempt.close()


def test_source_check_to_rename_race_is_detected_and_candidate_restored(tmp_path: Path) -> None:
    source_path = _source(tmp_path)
    outside = tmp_path / "outside-tree"
    outside.mkdir()
    (outside / "outside.txt").write_text("outside", encoding="utf-8")
    with _opened_source(tmp_path, source=source_path) as source:
        snapshot = snapshot_source_tree(source)
        attempt = _allocate(source, snapshot)
        _write_at(attempt.staging_handle.descriptor, "new.txt", b"new")
        raced = False

        def race_then_rename(
            src_parent: int, src_name: str, dst_parent: int, dst_name: str
        ) -> None:
            nonlocal raced
            if (
                not raced
                and src_parent == source.parent.descriptor
                and src_name == source.source_name
            ):
                os.rename(source_path, tmp_path / "inspected-source")
                os.rename(outside, source_path)
                raced = True
            _rename_no_replace_at(src_parent, src_name, dst_parent, dst_name)

        try:
            with pytest.raises(RecoverySwapError, match="atomic rename cliff") as raised:
                swap_staged_palace(
                    source,
                    attempt,
                    snapshot,
                    lambda _stage: VerificationResult(True, "unused"),
                    rename=race_then_rename,
                )
            assert raised.value.rollback_succeeded is True
            assert (source_path / "outside.txt").read_text(encoding="utf-8") == "outside"
            assert (tmp_path / "inspected-source" / "original.txt").is_file()
            assert not (source_path / "new.txt").exists()
        finally:
            attempt.close()


def test_parent_replacement_cannot_redirect_final_swap(tmp_path: Path) -> None:
    parent = tmp_path / "parent"
    parent.mkdir()
    source_path = _source(parent)
    receipt = _receipt(tmp_path, source_path)
    with open_authorized_recovery(source_path, receipt) as source:
        snapshot = snapshot_source_tree(source)
        attempt = _allocate(source, snapshot)
        _write_at(attempt.staging_handle.descriptor, "new.txt", b"new")
        moved_parent = tmp_path / "held-parent"
        os.rename(parent, moved_parent)
        replacement = parent / source_path.name
        replacement.mkdir(parents=True)
        (replacement / "outside.txt").write_text("outside", encoding="utf-8")
        try:
            with pytest.raises(ValidationError, match="ancestor changed"):
                swap_staged_palace(
                    source,
                    attempt,
                    snapshot,
                    lambda _stage: VerificationResult(True, "verified"),
                )
            assert (replacement / "outside.txt").read_text() == "outside"
            assert (moved_parent / source_path.name / "original.txt").read_text() == "original"
        finally:
            attempt.close()


def test_parent_and_ancestor_replacement_cannot_redirect_final_swap(tmp_path: Path) -> None:
    ancestor = tmp_path / "ancestor"
    parent = ancestor / "parent"
    parent.mkdir(parents=True)
    source_path = _source(parent)
    receipt = _receipt(tmp_path, source_path)
    with open_authorized_recovery(source_path, receipt) as source:
        snapshot = snapshot_source_tree(source)
        attempt = _allocate(source, snapshot)
        _write_at(attempt.staging_handle.descriptor, "new.txt", b"new")
        moved = tmp_path / "held-ancestor"
        os.rename(ancestor, moved)
        replacement = ancestor / "parent" / source_path.name
        replacement.mkdir(parents=True)
        (replacement / "outside.txt").write_text("outside", encoding="utf-8")
        try:
            with pytest.raises(ValidationError, match="ancestor changed"):
                swap_staged_palace(
                    source,
                    attempt,
                    snapshot,
                    lambda _stage: VerificationResult(True, "verified"),
                )
            assert (replacement / "outside.txt").read_text(encoding="utf-8") == "outside"
            held_parent = moved / "parent"
            assert (held_parent / source_path.name / "original.txt").read_text() == "original"
            assert (held_parent / attempt.root.name / attempt.staging.name / "new.txt").is_file()
        finally:
            attempt.close()


def test_success_returns_advisory_path_with_exact_backup_evidence(tmp_path: Path) -> None:
    with _opened_source(tmp_path) as source:
        snapshot = snapshot_source_tree(source)
        original_identity = _object_identity(source.target)
        attempt = _allocate(source, snapshot)
        _write_at(attempt.staging_handle.descriptor, "new.txt", b"new")
        try:
            result = swap_staged_palace(
                source,
                attempt,
                snapshot,
                lambda _stage: VerificationResult(True, "verified"),
            )
            evidence = result.backup
            attempt.close()

            assert evidence.advisory_path == attempt.backup
            assert (evidence.parked_identity.device, evidence.parked_identity.inode) == (
                original_identity
            )
            assert evidence.original_identity == snapshot.root_identity
            assert _object_identity(evidence.advisory_path) == original_identity
            parent_identity = _object_identity(evidence.advisory_path.parent)
            assert (evidence.parent_identity.device, evidence.parent_identity.inode) == (
                parent_identity
            )
            assert (source.target / "new.txt").read_text(encoding="utf-8") == "new"
        finally:
            attempt.close()


@pytest.mark.parametrize("replaced_names", ["installed", "backup", "both"])
def test_post_verification_name_drift_never_moves_or_restores_wrong_tree(
    tmp_path: Path,
    replaced_names: str,
) -> None:
    with _opened_source(tmp_path) as source:
        snapshot = snapshot_source_tree(source)
        original_identity = _object_identity(source.target)
        attempt = _allocate(source, snapshot)
        _write_at(attempt.staging_handle.descriptor, "new.txt", b"new")
        stage_identity = (
            attempt.staging_handle.identity.device,
            attempt.staging_handle.identity.inode,
        )
        installed_held = tmp_path / "verified-stage-held"
        backup_held = attempt.root / "original-held"

        def race_after_verification(_stage) -> VerificationResult:
            if replaced_names in {"installed", "both"}:
                os.rename(source.target, installed_held)
                source.target.mkdir()
                (source.target / "attacker-installed").write_text("attacker", encoding="utf-8")
            if replaced_names in {"backup", "both"}:
                os.rename(attempt.backup, backup_held)
                attempt.backup.mkdir()
                (attempt.backup / "attacker-backup").write_text("attacker", encoding="utf-8")
            return VerificationResult(True, "verified before deterministic race")

        try:
            with pytest.raises(RecoverySwapError) as raised:
                swap_staged_palace(
                    source,
                    attempt,
                    snapshot,
                    race_after_verification,
                )

            assert raised.value.rollback_succeeded is False
            assert not attempt.failed_swap.exists()
            if replaced_names in {"installed", "both"}:
                assert (source.target / "attacker-installed").read_text() == "attacker"
                assert _object_identity(installed_held) == stage_identity
            else:
                assert _object_identity(source.target) == stage_identity
                assert (source.target / "new.txt").read_text() == "new"
            if replaced_names in {"backup", "both"}:
                assert (attempt.backup / "attacker-backup").read_text() == "attacker"
                assert _object_identity(backup_held) == original_identity
                assert raised.value.backup is None
            else:
                assert _object_identity(attempt.backup) == original_identity
                assert raised.value.backup is not None
                evidence = raised.value.backup
                assert (evidence.parked_identity.device, evidence.parked_identity.inode) == (
                    original_identity
                )
        finally:
            attempt.close()


def test_success_event_failure_after_both_name_replacements_is_safe(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _opened_source(tmp_path) as source:
        snapshot = snapshot_source_tree(source)
        original_identity = _object_identity(source.target)
        attempt = _allocate(source, snapshot)
        _write_at(attempt.staging_handle.descriptor, "new.txt", b"new")
        stage_identity = (
            attempt.staging_handle.identity.device,
            attempt.staging_handle.identity.inode,
        )
        installed_held = tmp_path / "event-stage-held"
        backup_held = attempt.root / "event-original-held"
        real_event = recovery_safety._record_attempt_event

        def fail_success_and_rollback_events(attempt_arg, event: str, fields=None):
            if event == "swap-verified":
                os.rename(source.target, installed_held)
                source.target.mkdir()
                (source.target / "attacker-installed").write_text("attacker", encoding="utf-8")
                os.rename(attempt.backup, backup_held)
                attempt.backup.mkdir()
                (attempt.backup / "attacker-backup").write_text("attacker", encoding="utf-8")
                raise OSError("injected success event failure")
            if event == "rollback-failed":
                raise OSError("injected rollback event failure")
            return real_event(attempt_arg, event, fields)

        monkeypatch.setattr(
            recovery_safety,
            "_record_attempt_event",
            fail_success_and_rollback_events,
        )
        try:
            with pytest.raises(RecoverySwapError) as raised:
                swap_staged_palace(
                    source,
                    attempt,
                    snapshot,
                    lambda _stage: VerificationResult(True, "verified"),
                )

            assert raised.value.rollback_succeeded is False
            assert raised.value.backup is None
            assert raised.value.event_errors == ("rollback-failed:OSError",)
            assert (source.target / "attacker-installed").read_text() == "attacker"
            assert (attempt.backup / "attacker-backup").read_text() == "attacker"
            assert _object_identity(installed_held) == stage_identity
            assert _object_identity(backup_held) == original_identity
            assert not attempt.failed_swap.exists()
        finally:
            attempt.close()


def test_park_postcondition_failure_restores_original(tmp_path: Path, monkeypatch) -> None:
    with _opened_source(tmp_path) as source:
        snapshot = snapshot_source_tree(source)
        attempt = _allocate(source, snapshot)
        _write_at(attempt.staging_handle.descriptor, "new.txt", b"new")
        real_stat = recovery_safety._stat_member_at
        injected = False

        def fail_park_stat(parent: int, name: str, field: str):
            nonlocal injected
            if field == "parked recovery source" and not injected:
                injected = True
                raise ValidationError("injected postcondition failure")
            return real_stat(parent, name, field)

        monkeypatch.setattr(recovery_safety, "_stat_member_at", fail_park_stat)
        try:
            with pytest.raises(RecoverySwapError) as raised:
                swap_staged_palace(
                    source,
                    attempt,
                    snapshot,
                    lambda _stage: VerificationResult(True, "unused"),
                )
            assert raised.value.rollback_succeeded is True
            assert (source.target / "original.txt").read_text() == "original"
            assert (attempt.staging / "new.txt").read_text() == "new"
        finally:
            attempt.close()


def test_post_swap_verification_failure_restores_original_and_preserves_stage(
    tmp_path: Path,
) -> None:
    with _opened_source(tmp_path) as source:
        snapshot = snapshot_source_tree(source)
        attempt = _allocate(source, snapshot)
        _write_at(attempt.staging_handle.descriptor, "new.txt", b"new")
        try:
            with pytest.raises(RecoverySwapError) as raised:
                swap_staged_palace(
                    source,
                    attempt,
                    snapshot,
                    lambda _stage: VerificationResult(False, "injected"),
                )
            assert raised.value.rollback_succeeded is True
            assert (source.target / "original.txt").read_text() == "original"
            assert (attempt.failed_swap / "new.txt").read_text() == "new"
        finally:
            attempt.close()


def test_event_failure_does_not_mask_primary_rollback_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _opened_source(tmp_path) as source:
        snapshot = snapshot_source_tree(source)
        attempt = _allocate(source, snapshot)
        _write_at(attempt.staging_handle.descriptor, "new.txt", b"new")
        real_event = recovery_safety._record_attempt_event
        calls = 0

        def fail_rename(src_parent: int, src_name: str, dst_parent: int, dst_name: str) -> None:
            nonlocal calls
            calls += 1
            if calls >= 2:
                raise OSError("primary injected rename failure")
            _rename_no_replace_at(src_parent, src_name, dst_parent, dst_name)

        def fail_rollback_event(attempt_arg, event: str, fields=None):
            if event.startswith("rollback"):
                raise OSError("secondary event failure")
            return real_event(attempt_arg, event, fields)

        monkeypatch.setattr(recovery_safety, "_record_attempt_event", fail_rollback_event)
        try:
            with pytest.raises(RecoverySwapError) as raised:
                swap_staged_palace(
                    source,
                    attempt,
                    snapshot,
                    lambda _stage: VerificationResult(True, "unused"),
                    rename=fail_rename,
                )
            assert raised.value.rollback_succeeded is False
            assert "rollback failed" in str(raised.value)
            assert raised.value.event_errors == ("rollback-failed:OSError",)
        finally:
            attempt.close()


@pytest.mark.parametrize(
    ("limits", "setup", "code"),
    [
        (
            RecoveryLimits(max_input_bytes=700, max_staging_bytes=10_000, max_files=100),
            lambda source: (source / "large.bin").write_bytes(b"x" * 1_024),
            RecoveryRefusalCode.INPUT_BYTES,
        ),
        (
            RecoveryLimits(max_input_bytes=10_000, max_staging_bytes=10_000, max_files=2),
            lambda source: None,
            RecoveryRefusalCode.FILE_COUNT,
        ),
        (
            RecoveryLimits(
                max_input_bytes=10_000,
                max_staging_bytes=10_000,
                max_files=100,
                max_depth=1,
            ),
            lambda source: (source / "nested").mkdir(),
            RecoveryRefusalCode.DEPTH,
        ),
    ],
)
def test_input_file_and_depth_limits_are_typed(
    tmp_path: Path,
    limits: RecoveryLimits,
    setup,
    code: RecoveryRefusalCode,
) -> None:
    source_path = _source(tmp_path)
    setup(source_path)
    if code is RecoveryRefusalCode.DEPTH:
        (source_path / "nested" / "deep.txt").write_text("deep", encoding="utf-8")
    budget = RecoveryBudget(limits=limits)
    with _opened_source(tmp_path, budget=budget, source=source_path) as source:
        with pytest.raises(RecoveryRefusal) as raised:
            snapshot_source_tree(source)
    assert raised.value.code is code


def test_staging_byte_limit_is_typed(tmp_path: Path) -> None:
    source_path = _source(tmp_path)
    (source_path / "large.bin").write_bytes(b"x" * 1_024)
    limits = RecoveryLimits(
        max_input_bytes=10_000,
        max_staging_bytes=600,
        max_files=100,
    )
    with _opened_source(
        tmp_path,
        budget=RecoveryBudget(limits=limits),
        source=source_path,
    ) as source:
        snapshot = snapshot_source_tree(source)
        attempt = _allocate(source, snapshot)
        try:
            with pytest.raises(RecoveryRefusal) as raised:
                copy_preserved_entries(
                    source,
                    attempt,
                    snapshot,
                    excluded_names=frozenset(),
                )
            assert raised.value.code is RecoveryRefusalCode.STAGING_BYTES
        finally:
            attempt.close()


def test_total_deadline_and_cancellation_are_typed(tmp_path: Path) -> None:
    now = [0.0]
    budget = RecoveryBudget(
        limits=RecoveryLimits(deadline_seconds=1),
        clock=lambda: now[0],
    )
    with _opened_source(tmp_path, budget=budget) as source:
        now[0] = 2.0
        with pytest.raises(RecoveryRefusal) as deadline:
            snapshot_source_tree(source)
    assert deadline.value.code is RecoveryRefusalCode.DEADLINE

    cancelled = [False]
    cancel_budget = RecoveryBudget(cancelled=lambda: cancelled[0])
    second_root = tmp_path / "second"
    second_root.mkdir()
    with _opened_source(second_root, budget=cancel_budget) as source:
        cancelled[0] = True
        with pytest.raises(RecoveryRefusal) as cancellation:
            snapshot_source_tree(source)
    assert cancellation.value.code is RecoveryRefusalCode.CANCELLED
