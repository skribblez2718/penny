"""
sca Skill — Copyleft-source build guard (Phase 3).

``build_guard(scan_paths)`` scans directory trees for heuristic signs that the
SOURCE of a copyleft-invoke-only tool (trufflehog=AGPL, njsscan=LGPLv3, and
eslint-plugin-no-unsanitized=MPL-2.0 weak copyleft) has been vendored/embedded
into the repository. Embedding such source would create AGPL/LGPL/MPL
distribution obligations; sca's policy is INVOKE-ONLY (run the tool as a
separate process, never ship its code). Invoking a tool, or vendoring an
opaque binary, is fine — only embedded SOURCE fails the guard.

Deliberately generic/reusable: it reads the copyleft tool list and each tool's
source signatures from ``tool_manifest`` rather than hardcoding extension paths,
so it keeps working when the Phase-4 tool extensions land.

Heuristic (two-factor, to avoid false positives):
  1. The file must have a SOURCE-CODE extension (.go/.py/.js/...). A directory
     merely NAMED after a tool, or a .md/.yaml that only mentions the tool, is
     documentation/config and does not trip the guard.
  2. The file's text must contain one of the tool's OWN source signatures
     (import path / package / module marker from the manifest).

SECURITY: no network, no subprocess. Reads are bounded per file; undecodable
(binary) files are skipped, so vendored binaries (invoke-only) pass cleanly.
The walk prunes VCS/dep/vendor-noise dirs and is depth/entry bounded.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import List, Tuple

from tool_manifest import copyleft_tools


# Extensions that denote actual source code (two-factor rule, factor 1).
SOURCE_EXTENSIONS = frozenset(
    {
        ".go",
        ".py",
        ".pyi",
        ".js",
        ".jsx",
        ".ts",
        ".tsx",
        ".mjs",
        ".cjs",
        ".rb",
        ".java",
        ".rs",
        ".c",
        ".cc",
        ".cpp",
        ".h",
        ".hpp",
    }
)

# Directories not worth walking (VCS metadata, virtualenvs, build noise).
_IGNORE_DIRS = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".venv",
        "venv",
        "__pycache__",
        ".tox",
        ".mypy_cache",
        ".pytest_cache",
    }
)

# Bounds (DoS guardrails).
_MAX_DEPTH = 20
_MAX_ENTRIES = 200000
_MAX_READ_BYTES = 512 * 1024  # only scan the head of each source file


def _read_text_head(path: str) -> str:
    """Return up to _MAX_READ_BYTES of decoded text, or "" if undecodable.

    Binary blobs (e.g. a vendored tool binary) fail to decode as UTF-8 and are
    treated as empty -> they never match a source signature. This is what keeps
    the invoke-only / binary-only case passing.
    """
    try:
        with open(path, "rb") as fh:
            raw = fh.read(_MAX_READ_BYTES)
    except OSError:  # pragma: no cover - defensive
        return ""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return ""


def _scan_file(path: str) -> List[str]:
    """Return violations for a single file (empty list if clean)."""
    ext = os.path.splitext(path)[1].lower()
    if ext not in SOURCE_EXTENSIONS:
        return []  # factor 1 failed: not a source file
    text = _read_text_head(path)
    if not text:
        return []
    violations: List[str] = []
    for spec in copyleft_tools():
        for sig in spec.source_signatures:
            if sig in text:
                violations.append(
                    f"{spec.name}: embedded copyleft source detected at "
                    f"{path} (matched {sig!r}; license_tier={spec.license_tier}, "
                    f"spdx={spec.spdx_license}) -- policy is INVOKE-ONLY, "
                    "source must not be vendored/committed"
                )
                break  # one signature is enough per tool per file
    return violations


def _walk_files(root: str):
    """Yield file paths under ``root`` (a dir or a single file), bounded."""
    if os.path.isfile(root):
        yield root
        return
    if not os.path.isdir(root):
        return
    entries_seen = 0
    for dirpath, dirnames, filenames in os.walk(root, topdown=True):
        rel = os.path.relpath(dirpath, root)
        depth = 0 if rel == "." else rel.count(os.sep) + 1
        if depth >= _MAX_DEPTH:
            dirnames[:] = []
        dirnames[:] = [d for d in dirnames if d not in _IGNORE_DIRS]
        entries_seen += len(filenames) + len(dirnames)
        if entries_seen > _MAX_ENTRIES:  # pragma: no cover - DoS guardrail
            break
        for fn in filenames:
            yield os.path.join(dirpath, fn)


def build_guard(scan_paths: List[str]) -> Tuple[bool, List[str]]:
    """Scan ``scan_paths`` for embedded copyleft tool SOURCE.

    Returns ``(ok, violations)``:
      - ``ok`` is True when no embedded copyleft source is found (clean tree,
        invoke-only binary tree, docs/config-only, or non-existent path).
      - ``ok`` is False with a non-empty ``violations`` list when vendored
        copyleft source is detected.

    Never raises; unreadable files/paths are skipped. ``scan_paths`` may name
    directories or individual files.
    """
    violations: List[str] = []
    for scan_path in scan_paths or []:
        if not isinstance(scan_path, str) or not scan_path.strip():
            continue
        for file_path in _walk_files(scan_path):
            violations.extend(_scan_file(file_path))
    return (len(violations) == 0, violations)
