"""The legacy bridge cannot be redirected away from its receipt-bound copy."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from memory_bridge import (  # noqa: E402
    _OFFLINE_AUTHORIZATION,
    _apply_palace_path_env_compat,
)


def test_authorized_target_is_reasserted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MEMPALACE_PALACE_PATH", raising=False)

    _apply_palace_path_env_compat()

    assert os.environ["MEMPALACE_PALACE_PATH"] == str(_OFFLINE_AUTHORIZATION.target)


def test_legacy_alias_cannot_redirect_the_copy(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MEMPALACE_PATH", "/different-path")

    with pytest.raises(RuntimeError, match="cannot redirect"):
        _apply_palace_path_env_compat()


def test_import_without_offline_flag_fails_before_raw_peer_import() -> None:
    environment = os.environ.copy()
    environment.pop("PENNY_MEMORY_BRIDGE_OFFLINE_COMPAT", None)
    bridge_dir = Path(__file__).resolve().parents[1]

    completed = subprocess.run(
        [sys.executable, "-c", "import memory_bridge"],
        cwd=bridge_dir,
        env={**environment, "PYTHONPATH": os.pathsep.join(sys.path)},
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode != 0
    assert "offline/test compatibility only" in completed.stderr
