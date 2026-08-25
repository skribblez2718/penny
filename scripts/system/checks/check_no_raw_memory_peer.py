#!/usr/bin/env python3
"""Static guard against production raw MemPalace/Chroma peer access."""

from __future__ import annotations

import ast
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[3]
SCAN_PATHS = (
    "scripts/setup/init-memory.sh",
    "scripts/system/bridge",
    "scripts/system/memory",
    "scripts/system/tiered_memory",
)
HUB_OWNER_MODULES = frozenset({"scripts/system/memory/hub_service.py"})
OFFLINE_MODULES = frozenset(
    {
        "scripts/system/bridge/fts5_integrity.py",
        "scripts/system/bridge/palace_doctor.py",
        "scripts/system/bridge/repair_palace.py",
        "scripts/system/bridge/rebuild_from_disk.py",
    }
)
SYNTHETIC_MODULES = frozenset({"scripts/system/memory/candidate_preflight.py"})
ALLOWED_TEST_PREFIXES = (
    "scripts/system/bridge/tests/",
    "scripts/system/memory/tests/",
)
RAW_IMPORT_ROOTS = frozenset({"chromadb", "mempalace", "memory_bridge"})
RAW_SPAWN_MARKERS = (
    "memory_bridge.py",
    "scripts.system.bridge.memory_bridge",
    "PI_MEMORY_BRIDGE",
    "mempalace.mcp_server",
)


@dataclass(frozen=True)
class RawPeerViolation:
    path: str
    line: int
    reason: str


def _allowed(relative: str) -> bool:
    return (
        relative in HUB_OWNER_MODULES
        or relative in OFFLINE_MODULES
        or relative in SYNTHETIC_MODULES
        or relative.startswith(ALLOWED_TEST_PREFIXES)
    )


def _import_roots(node: ast.AST) -> Iterable[str]:
    if isinstance(node, ast.Import):
        return (alias.name.split(".", 1)[0] for alias in node.names)
    if isinstance(node, ast.ImportFrom) and node.module:
        return (node.module.split(".", 1)[0],)
    return ()


def _ast_violations(relative: str, tree: ast.AST) -> list[RawPeerViolation]:
    violations: list[RawPeerViolation] = []
    for node in ast.walk(tree):
        violations.extend(
            RawPeerViolation(relative, getattr(node, "lineno", 1), f"raw peer import: {root}")
            for root in _import_roots(node)
            if root in RAW_IMPORT_ROOTS
        )
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "PersistentClient"
        ):
            violations.append(
                RawPeerViolation(relative, node.lineno, "direct Chroma PersistentClient")
            )
    return violations


def _python_violations(relative: str, source: str) -> list[RawPeerViolation]:
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return [
            RawPeerViolation(relative, exc.lineno or 1, "cannot parse source for raw-peer guard")
        ]
    violations = _ast_violations(relative, tree)
    if "chroma.sqlite3" in source and "sqlite3.connect" in source:
        line = next(
            (
                index
                for index, text in enumerate(source.splitlines(), start=1)
                if "sqlite3.connect" in text
            ),
            1,
        )
        violations.append(RawPeerViolation(relative, line, "direct Chroma sqlite byte access"))
    return violations


def _spawn_violations(relative: str, source: str) -> list[RawPeerViolation]:
    violations: list[RawPeerViolation] = []
    lines = source.splitlines()
    for marker in RAW_SPAWN_MARKERS:
        for line_number, line in enumerate(lines, start=1):
            if marker in line:
                violations.append(
                    RawPeerViolation(relative, line_number, f"raw peer spawn/reference: {marker}")
                )
    return violations


def _runtime_gate_violations(relative: str, source: str) -> list[RawPeerViolation]:
    if relative not in OFFLINE_MODULES:
        return []
    violations: list[RawPeerViolation] = []
    if "authorize_offline_target" not in source:
        violations.append(
            RawPeerViolation(relative, 1, "offline module lacks runtime receipt gate")
        )
    return violations


def _synthetic_gate_violations(relative: str, source: str) -> list[RawPeerViolation]:
    if relative not in SYNTHETIC_MODULES:
        return []
    if "TemporaryDirectory" in source and "--offline-target" not in source:
        return []
    return [
        RawPeerViolation(
            relative,
            1,
            "synthetic raw module must create only temporary data and accept no offline target",
        )
    ]


def scan(root: Path = ROOT) -> list[RawPeerViolation]:
    """Return all disallowed raw-peer accesses in the selected source corpus."""

    candidates: set[Path] = set()
    for selected in SCAN_PATHS:
        path = root / selected
        if path.is_file():
            candidates.add(path)
        elif path.is_dir():
            candidates.update(path.rglob("*.py"))
            candidates.update(path.rglob("*.sh"))
    violations: list[RawPeerViolation] = []
    for path in sorted(candidates):
        if "__pycache__" in path.parts:
            continue
        relative = path.relative_to(root).as_posix()
        source = path.read_text(encoding="utf-8")
        if not _allowed(relative):
            violations.extend(_spawn_violations(relative, source))
            if path.suffix == ".py":
                violations.extend(_python_violations(relative, source))
        violations.extend(_runtime_gate_violations(relative, source))
        violations.extend(_synthetic_gate_violations(relative, source))
    return violations


def main() -> int:
    try:
        violations = scan()
    except OSError as exc:
        print(f"ERROR: raw-memory-peer guard unavailable: {exc}", file=sys.stderr)
        return 2
    for violation in violations:
        print(f"{violation.path}:{violation.line}: {violation.reason}")
    if violations:
        print(f"FAIL: {len(violations)} raw-memory-peer violation(s)")
        return 1
    print("PASS: normal Python/admin/eval/retention paths use only the supervised HTTP hub")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
