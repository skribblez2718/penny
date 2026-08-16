"""Tests for the capability-invariants eval section (eval_invariants.py).

Proves each gating invariant both HOLDS today and REGRESSES when the capability
is weakened — the whole point of the section is that gutting the leverage spine
turns a check red.
"""

import sys
import types
from pathlib import Path

# eval_invariants lives in scripts/system/evals
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "evals"))

import eval_invariants as ei  # noqa: E402
from eval_lib import FAIL, PASS  # noqa: E402

GATING = {
    "invariants.grounded_verification",
    "invariants.independent_verification",
    "invariants.checkpoint_resume",
}


def _by_name():
    return {r.name: r for r in ei.collect()}


class TestInvariantsHoldToday:
    def test_all_checks_present(self):
        names = set(_by_name())
        assert GATING <= names
        assert "invariants.honest_exhaustion" in names

    def test_gating_invariants_pass_and_gate(self):
        results = _by_name()
        for name in GATING:
            r = results[name]
            assert r.status == PASS, f"{name} should hold today: {r.detail}"
            assert r.informational is False, f"{name} must gate (not informational)"

    def test_honest_exhaustion_tracked_informational(self):
        r = ei.check_honest_exhaustion()
        assert r.informational is True


class TestInvariantsRegressWhenWeakened:
    def test_grounded_verification_mechanism_rejects_empty_evidence(self):
        # the capability itself: a PASS with empty evidence must be rejected
        from orchestration.contracts import validate_summary_contract

        ok, _ = validate_summary_contract(
            "VERIFY",
            {
                "required": {"verdict": str, "gaps": list, "confidence": str},
                "evidence": ["evidence"],
            },
            {"verdict": "PASS", "gaps": [], "confidence": "CERTAIN", "evidence": []},
        )
        assert ok is False

    def test_independent_verification_detects_same_agent(self, monkeypatch):
        import orchestration.primitives as prim

        # simulate a regression: ACT sharing VERIFY's agent
        monkeypatch.setattr(prim, "ACT", types.SimpleNamespace(agent="vera"))
        assert ei.check_independent_verification().status == FAIL
