from __future__ import annotations

import json
from pathlib import Path

import pytest

from memory.common import ValidationError
from memory.offline_access import authorize_offline_target


def _receipt(path: Path, target: Path, *, checks: dict[str, bool] | None = None) -> Path:
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "receipt_type": "memory-offline-access",
                "target_kind": "copied-offline",
                "target_path": str(target),
                "source_id": "synthetic-source",
                "authority_timestamp": "2026-08-15T12:00:00Z",
                "approved_by": "synthetic-test-owner",
                "checks": checks
                or {
                    "drain_complete": True,
                    "hub_stopped": True,
                    "peer_processes_stopped": True,
                    "target_is_copy": True,
                },
            }
        ),
        encoding="utf-8",
    )
    path.chmod(0o600)
    return path


def test_authorizes_absolute_receipt_bound_copy(tmp_path: Path) -> None:
    target = tmp_path / "copy"
    target.mkdir()
    receipt = _receipt(tmp_path / "receipt.json", target)

    authorization = authorize_offline_target(target, receipt, environment={})

    assert authorization.target == target.resolve()
    assert authorization.source_id == "synthetic-source"


def test_rejects_relative_target_before_byte_access(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    target = Path("copy")
    target.mkdir()
    receipt = _receipt(tmp_path / "receipt.json", target.resolve())

    with pytest.raises(ValidationError, match="explicit absolute"):
        authorize_offline_target(target, receipt, environment={})


def test_rejects_configured_live_target(tmp_path: Path) -> None:
    target = tmp_path / "live"
    target.mkdir()
    receipt = _receipt(tmp_path / "receipt.json", target)

    with pytest.raises(ValidationError, match="configured live"):
        authorize_offline_target(
            target,
            receipt,
            environment={"MEMPALACE_PALACE_PATH": str(target)},
        )


@pytest.mark.parametrize(
    "failed_check",
    ["drain_complete", "hub_stopped", "peer_processes_stopped", "target_is_copy"],
)
def test_rejects_unsafe_drain_hub_or_peer_receipt(tmp_path: Path, failed_check: str) -> None:
    target = tmp_path / "copy"
    target.mkdir()
    checks = {
        "drain_complete": True,
        "hub_stopped": True,
        "peer_processes_stopped": True,
        "target_is_copy": True,
    }
    checks[failed_check] = False
    receipt = _receipt(tmp_path / "receipt.json", target, checks=checks)

    with pytest.raises(ValidationError, match="unsafe checks"):
        authorize_offline_target(target, receipt, environment={})


def test_rejects_receipt_for_a_different_copy(tmp_path: Path) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    receipt = _receipt(tmp_path / "receipt.json", first)

    with pytest.raises(ValidationError, match="does not match"):
        authorize_offline_target(second, receipt, environment={})
