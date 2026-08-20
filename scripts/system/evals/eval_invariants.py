#!/usr/bin/env python3
"""Capability invariants backed by the TypeScript orchestration test surface."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Callable, List, Tuple

from eval_lib import FAIL, PASS, EvalResult, run_checks

ROOT = Path(__file__).resolve().parents[3]


def _vitest(*files: str) -> tuple[bool, str]:
    result = subprocess.run(
        ["bunx", "vitest", "run", *files],
        cwd=ROOT / "apps" / "orchestration",
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    detail = (result.stdout + result.stderr).strip().splitlines()
    return result.returncode == 0, detail[-1] if detail else "no test output"


def _result(
    name: str, files: tuple[str, ...], capability: str, *, informational=False
) -> EvalResult:
    ok, detail = _vitest(*files)
    return EvalResult(
        name=name,
        status=PASS if ok else FAIL,
        informational=informational,
        detail=f"{capability}: {detail}",
    )


def check_grounded_verification() -> EvalResult:
    return _result(
        "invariants.grounded_verification",
        ("tests/contracts.test.ts", "tests/research-parity.test.ts"),
        "closed evidence and verifier-routing contracts",
    )


def check_independent_verification() -> EvalResult:
    return _result(
        "invariants.independent_verification",
        ("tests/research-parity-pin.test.ts", "tests/worker-posture.test.ts"),
        "separate synthesis/verification agents and SSOT posture",
    )


def check_checkpoint_resume() -> EvalResult:
    return _result(
        "invariants.checkpoint_resume",
        ("tests/core-runtime.test.ts", "tests/initial-artifacts.test.ts"),
        "durable exact-run recovery and composition ingress",
    )


def check_honest_exhaustion() -> EvalResult:
    return _result(
        "invariants.honest_exhaustion",
        ("tests/research-parity.test.ts", "tests/completion-gate.test.ts"),
        "bounded repairs and honest terminal admission",
        informational=True,
    )


CHECKS: List[Tuple[str, Callable[[], EvalResult]]] = [
    ("invariants.grounded_verification", check_grounded_verification),
    ("invariants.independent_verification", check_independent_verification),
    ("invariants.checkpoint_resume", check_checkpoint_resume),
    ("invariants.honest_exhaustion", check_honest_exhaustion),
]


def collect() -> List[EvalResult]:
    return run_checks(CHECKS)
