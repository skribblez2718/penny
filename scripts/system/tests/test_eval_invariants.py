"""TypeScript orchestration capability-eval tests."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
EVALS = ROOT / "scripts" / "system" / "evals"
sys.path.insert(0, str(EVALS))

import eval_invariants as ei  # noqa: E402
from eval_lib import FAIL, PASS  # noqa: E402


def test_all_checks_present() -> None:
    assert [name for name, _ in ei.CHECKS] == [
        "invariants.grounded_verification",
        "invariants.independent_verification",
        "invariants.checkpoint_resume",
        "invariants.honest_exhaustion",
    ]


def test_gating_invariants_pass_when_typescript_evidence_is_green(monkeypatch) -> None:
    monkeypatch.setattr(ei, "_vitest", lambda *_files: (True, "tests passed"))
    results = ei.collect()
    assert all(result.status == PASS for result in results)
    assert results[-1].informational is True
    assert all(not result.informational for result in results[:-1])


def test_gating_invariant_regresses_when_typescript_evidence_fails(monkeypatch) -> None:
    monkeypatch.setattr(ei, "_vitest", lambda *_files: (False, "test failed"))
    result = ei.check_grounded_verification()
    assert result.status == FAIL
    assert "test failed" in result.detail


def test_each_check_names_real_typescript_test_evidence(monkeypatch) -> None:
    captured: list[tuple[str, ...]] = []

    def fake(*files: str) -> tuple[bool, str]:
        captured.append(files)
        return True, "ok"

    monkeypatch.setattr(ei, "_vitest", fake)
    ei.collect()
    assert captured
    assert all(files and all(path.endswith(".test.ts") for path in files) for files in captured)
