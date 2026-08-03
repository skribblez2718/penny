"""Deterministic contract checks — no live-store data required.

These catch the class of failure Penny has been bitten by repeatedly: a writer
and a consumer silently disagreeing about a schema, or code existing but never
being exercised. They are cheap enough to run in ``make test``.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Callable, List, Tuple

from eval_lib import (
    FAIL,
    PASS,
    REPO_ROOT,
    EvalResult,
    run_checks,
)

# Directories `make test` actually collects (Makefile pytest loop). A test file
# outside these is DEAD: it exists, it reassures, it never runs.
COLLECTED_TEST_GLOBS: Tuple[str, ...] = (
    "scripts/system/tests",
    "scripts/system/*/tests",
    ".pi/skills/*/tests",
    "apps/orchestration/tests",
    "apps/observability/tests",
    "apps/observability/src/observability/tests",
)

SCAN_ROOTS: Tuple[str, ...] = ("scripts", "apps", ".pi/skills")
EXCLUDED_PARTS = {"__pycache__", "node_modules", ".venv"}


def find_dead_tests(root: Path) -> List[str]:
    """Python test files that no ``make test`` pytest invocation ever collects."""
    collected: List[Path] = []
    for pattern in COLLECTED_TEST_GLOBS:
        collected.extend(p.resolve() for p in root.glob(pattern) if p.is_dir())

    dead: List[str] = []
    for scan in SCAN_ROOTS:
        base = root / scan
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("test_*.py")):
            if EXCLUDED_PARTS.intersection(path.parts):
                continue
            resolved = path.resolve()
            if not any(d in resolved.parents for d in collected):
                dead.append(str(path.relative_to(root)))
    return dead


def check_dead_tests() -> EvalResult:
    dead = find_dead_tests(REPO_ROOT)
    if dead:
        return EvalResult(
            name="compat.dead_tests",
            status=FAIL,
            value=float(len(dead)),
            direction="down_good",
            unit="count",
            detail="never collected by make test: " + ", ".join(dead[:6]),
        )
    return EvalResult(
        name="compat.dead_tests",
        status=PASS,
        value=0.0,
        direction="down_good",
        unit="count",
        detail="every python test file is under a collected tests/ dir",
    )


def check_archiver_archive_callable() -> EvalResult:
    """The cold-storage archiver must work when imported, not only under __main__.

    ``_make_jsonl_archiver`` uses ``os`` which is imported only inside the
    ``if __name__ == "__main__"`` block — fine from cron, NameError from any
    importing caller (tests, future code). Guard against reintroduction once
    fixed, and surface it until then.
    """
    tiered = str(REPO_ROOT / "scripts" / "system" / "tiered_memory")
    if tiered not in sys.path:
        sys.path.insert(0, tiered)
    import archiver  # type: ignore[import-not-found]

    drawer = archiver.DrawerMeta(
        drawer_id="eval-archiver-probe",
        wing="penny",
        room="signals",
        timestamp="2026-01-01T00:00:00+00:00",
        content="probe",
    )
    with tempfile.TemporaryDirectory() as tmp:
        try:
            path = archiver._make_jsonl_archiver(tmp)(drawer)
        except NameError as exc:
            return EvalResult(
                name="compat.archiver_archive_callable",
                status=FAIL,
                detail=f"NameError when called from an import context: {exc} "
                "(archiver.py imports os only under __main__)",
            )
        if not Path(path).is_file():
            return EvalResult(
                name="compat.archiver_archive_callable",
                status=FAIL,
                detail=f"archive callable returned {path} but wrote no file",
            )
    return EvalResult(
        name="compat.archiver_archive_callable",
        status=PASS,
        detail="cold-storage archiver works from an import context",
    )


CHECKS: List[Tuple[str, Callable[[], EvalResult]]] = [
    ("compat.dead_tests", check_dead_tests),
    ("compat.archiver_archive_callable", check_archiver_archive_callable),
]


def collect() -> List[EvalResult]:
    return run_checks(CHECKS)
