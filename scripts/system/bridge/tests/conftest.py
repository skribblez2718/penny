"""Authorize only a synthetic copied/offline target for legacy bridge tests."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

_OFFLINE_ROOT = Path(tempfile.mkdtemp(prefix="penny-memory-bridge-tests-"))
_OFFLINE_TARGET = _OFFLINE_ROOT / "copied-palace"
_OFFLINE_TARGET.mkdir(mode=0o700)
_OFFLINE_RECEIPT = _OFFLINE_ROOT / "receipt.json"
_OFFLINE_RECEIPT.write_text(
    json.dumps(
        {
            "schema_version": 1,
            "receipt_type": "memory-offline-access",
            "target_kind": "copied-offline",
            "target_path": str(_OFFLINE_TARGET),
            "source_id": "synthetic-bridge-tests",
            "authority_timestamp": "2026-08-15T12:00:00Z",
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
_OFFLINE_RECEIPT.chmod(0o600)

for _name in (
    "MEMPALACE_PALACE_PATH",
    "MEMPAL_PALACE_PATH",
    "MEMPALACE_PATH",
    "PENNY_MEMORY_HUB_CONFIG",
):
    os.environ.pop(_name, None)
os.environ["PENNY_MEMORY_BRIDGE_OFFLINE_COMPAT"] = "1"
os.environ["PENNY_MEMORY_OFFLINE_TARGET"] = str(_OFFLINE_TARGET)
os.environ["PENNY_MEMORY_OFFLINE_RECEIPT"] = str(_OFFLINE_RECEIPT)
_SYSTEM_ROOT = str(Path(__file__).resolve().parents[2])
_existing_pythonpath = os.environ.get("PYTHONPATH", "")
os.environ["PYTHONPATH"] = os.pathsep.join(
    part for part in (_SYSTEM_ROOT, _existing_pythonpath) if part
)
