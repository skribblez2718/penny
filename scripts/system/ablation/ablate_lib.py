#!/usr/bin/env python3
"""Shared artifact plumbing for Penny's retained research ablations."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List


def write_artifact(path: Path, data: Dict[str, Any]) -> None:
    """Write a complete JSON ablation artifact."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fingerprint_files(paths: List[Path], repo_root: Path) -> List[Dict[str, str]]:
    """Return repo-relative SHA-256 invalidators for an ablation artifact."""
    out: List[Dict[str, str]] = []
    for path in paths:
        try:
            relative = str(path.resolve().relative_to(repo_root.resolve()))
        except ValueError:
            relative = str(path)
        out.append({"path": relative, "sha256": _sha256_file(path)})
    return out
