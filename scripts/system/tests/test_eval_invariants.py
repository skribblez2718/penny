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
    "invariants.hitl_gates_present",
    "invariants.checkpoint_resume",
}


def _by_name():
    return {r.name: r for r in ei.collect()}


class TestInvariantsHoldToday:
    def test_all_checks_present(self):
        names = set(_by_name())
        assert GATING <= names
        assert "invariants.honest_exhaustion" in names
        assert "invariants.model_scaling_self_improve" in names

    def test_gating_invariants_pass_and_gate(self):
        results = _by_name()
        for name in GATING:
            r = results[name]
            assert r.status == PASS, f"{name} should hold today: {r.detail}"
            assert r.informational is False, f"{name} must gate (not informational)"

    def test_model_scaling_self_improve_holds_and_stays_nongating(self):
        """The capability now holds: improvement text is model-drafted or
        human-authored, never rendered by a string template. Still
        informational — it tracks a behavioural property and must not gate."""
        r = ei.check_model_scaling_self_improve()
        assert r.status == PASS, r.detail
        assert r.informational is True

    def test_model_scaling_self_improve_regresses_if_template_reintroduced(self):
        """Ratchet direction: reintroducing a template renderer under ANY name
        matching *guidance_text* must turn the invariant RED, not pass silently.

        Guards the actual defect — a template that interpolated ledger ids and
        raw free-text reasons into a git-tracked agent prompt.
        """
        import sys
        from pathlib import Path

        self_improve = (
            Path(ei.__file__).resolve().parents[1] / "self_improve"
        )
        if str(self_improve) not in sys.path:
            sys.path.insert(0, str(self_improve))
        import compression_loop

        compression_loop.build_guidance_text = lambda *a, **k: ""
        try:
            r = ei.check_model_scaling_self_improve()
            assert r.status == FAIL
            assert "build_guidance_text" in r.detail
        finally:
            del compression_loop.build_guidance_text

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

    def test_hitl_gate_regression_detected(self, monkeypatch):
        from orchestration.playbooks import PLAYBOOKS

        # simulate emptying a high-stakes gate
        monkeypatch.setattr(PLAYBOOKS["code"], "GATE_STATES", frozenset())
        r = ei.check_hitl_gates_present()
        assert r.status == FAIL
        assert "code" in r.detail
