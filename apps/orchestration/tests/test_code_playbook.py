"""Integration tests for the migrated code skill (CodePlaybook) on the engine.

Each step() constructs a FRESH playbook instance pointed at the same checkpointer
(subprocess-per-invocation reality), so these exercise the run_id/checkpointer
contract, the two planned gates, the Ralph-Wiggum retry loop, and the PRD hard
dependency — with NO --state and NO /tmp.
"""

import pytest

from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.playbooks.code import CodePlaybook

SID, RID = "sess-code", "run-code"

IDEAL = {
    "goal": "add pagination to the search API",
    "language": "python",
    "success_criteria": ["results are paginated", "page size is configurable"],
    "anti_criteria": ["no breaking API changes"],
    "deliverables": ["search endpoint"],
    "build_order": ["add page params", "wire into query"],
    "verification": {"unit_tests": True},
    "security_review": [],
}


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


def _start(cp, constraints=None):
    return CodePlaybook(cp).start(
        session_id=SID,
        run_id=RID,
        goal=IDEAL["goal"],
        constraints=constraints if constraints is not None else {"ideal_state": IDEAL},
    )


def _step(cp, agent, result):
    return CodePlaybook(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


# ---------------------------------------------------------------------------
# PRD hard dependency
# ---------------------------------------------------------------------------


def test_start_without_ideal_state_errors_with_chain_contract(cp):
    d = CodePlaybook(cp).start(session_id=SID, run_id=RID, goal="x", constraints={})
    assert d["action"] == "error"
    assert any("PRD dependency not satisfied" in e for e in d["errors"])


def test_start_with_ideal_state_emits_explore(cp):
    d = _start(cp)
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "echo" and d["state_id"] == "exploring"
    assert d["run_id"] == RID and "orchestrator_state" not in d


# ---------------------------------------------------------------------------
# Full happy path (both gates, final verify)
# ---------------------------------------------------------------------------


def test_full_walk_with_gates_to_complete(cp):
    _start(cp)
    assert (
        _step(cp, "echo", {"findings_count": 3, "confidence": "PROBABLE"})["state_id"]
        == "analyzing"
    )
    assert (
        _step(cp, "annie", {"risks_identified": 2, "confidence": "PROBABLE"})["state_id"]
        == "checking_criteria"
    )
    # criteria are fine -> straight to planning (no gate)
    assert _step(cp, "carren", {"gap": False, "confidence": "CERTAIN"})["state_id"] == "planning"
    # planning routes into the plan-approval gate
    d_gate = _step(cp, "piper", {"plan_complete": True, "confidence": "PROBABLE"})
    assert d_gate["action"] == "escalate_to_user" and d_gate["previous_state"] == "plan_gate"
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER and rec.current_state_id == "plan_gate"
    # approve -> implementing
    assert _step(cp, "user", {"user_response": "approve"})["state_id"] == "implementing"
    assert _step(cp, "skribble", {"confidence": "PROBABLE"})["state_id"] == "verifying"
    # verify passes (with captured evidence) -> learning
    assert (
        _step(
            cp,
            "skribble",
            {"passed": True, "confidence": "PROBABLE", "evidence": ["pytest: 12 passed"]},
        )["state_id"]
        == "learning"
    )
    # learn: no gap -> a final verification battery
    assert _step(cp, "carren", {"gap": False})["state_id"] == "verifying"
    # final verify passes -> complete, met=True
    d = _step(
        cp,
        "skribble",
        {"passed": True, "confidence": "CERTAIN", "evidence": ["pytest: 12 passed"]},
    )
    assert d["action"] == "complete" and d["result"]["met"] is True
    assert d["result"]["verify_passed"] is True


# ---------------------------------------------------------------------------
# Criteria gate path
# ---------------------------------------------------------------------------


def _advance_to_checking(cp):
    _start(cp)
    _step(cp, "echo", {"findings_count": 1, "confidence": "PROBABLE"})
    _step(cp, "annie", {"risks_identified": 1, "confidence": "PROBABLE"})


def test_criteria_gap_opens_gate_then_accept_resumes_planning(cp):
    _advance_to_checking(cp)
    d = _step(
        cp,
        "carren",
        {
            "gap": True,
            "confidence": "POSSIBLE",
            "findings": ["criterion 2 is vague"],
            "criteria_issues": {"2": ["not measurable"]},
        },
    )
    assert d["action"] == "escalate_to_user" and d["previous_state"] == "criteria_gate"
    # accept-as-is -> planning
    assert _step(cp, "user", {"user_response": "accept"})["state_id"] == "planning"


def test_criteria_gap_refine_re_runs_carren(cp):
    _advance_to_checking(cp)
    _step(cp, "carren", {"gap": True, "confidence": "POSSIBLE", "findings": ["vague"]})
    # refine -> back to checking_criteria (re-run carren)
    assert (
        _step(cp, "user", {"user_response": "make criterion 2 measurable"})["state_id"]
        == "checking_criteria"
    )


# ---------------------------------------------------------------------------
# Plan deny -> error (deliberate fix vs. legacy false-complete)
# ---------------------------------------------------------------------------


def _advance_to_plan_gate(cp):
    _start(cp)
    _step(cp, "echo", {"findings_count": 1, "confidence": "PROBABLE"})
    _step(cp, "annie", {"risks_identified": 1, "confidence": "PROBABLE"})
    _step(cp, "carren", {"gap": False, "confidence": "CERTAIN"})
    _step(cp, "piper", {"plan_complete": True, "confidence": "PROBABLE"})


def test_plan_deny_terminates_in_error(cp):
    _advance_to_plan_gate(cp)
    d = _step(cp, "user", {"user_response": "deny"})
    assert d["action"] == "error"
    assert any("denied" in e for e in d["errors"])


def test_plan_refine_routes_back_to_planning(cp):
    _advance_to_plan_gate(cp)
    assert _step(cp, "user", {"user_response": "use cursor-based paging"})["state_id"] == "planning"


# ---------------------------------------------------------------------------
# Ralph-Wiggum retry loop + budget exhaustion
# ---------------------------------------------------------------------------


_VERIFY_PASS = {"passed": True, "confidence": "PROBABLE", "evidence": ["pytest: 12 passed"]}


def _verify_fail(tag):
    """A contract-compliant FAILING verify SUMMARY (evidence-bearing)."""
    return {
        "passed": False,
        "confidence": "PROBABLE",
        "evidence": [f"pytest: {tag} failed"],
        "failures": [f"unresolved: {tag}"],
    }


def _advance_to_learning(cp):
    _advance_to_plan_gate(cp)
    _step(cp, "user", {"user_response": "approve"})
    _step(cp, "skribble", {"confidence": "PROBABLE"})  # implementing
    _step(cp, "skribble", _VERIFY_PASS)  # verifying -> learning


def _back_to_learning(cp, findings, strategy_change):
    """implementing -> verifying -> learning again, carrying a LEARN retry."""
    _step(cp, "carren", {"gap": True, "findings": findings, "strategy_change": strategy_change})
    _step(cp, "skribble", {"confidence": "PROBABLE"})  # implementing -> verifying
    _step(cp, "skribble", _VERIFY_PASS)  # verifying -> learning


def test_learn_gap_loops_back_to_implement(cp):
    _advance_to_learning(cp)
    d = _step(
        cp, "carren", {"gap": True, "findings": ["criterion 2 unmet"], "strategy_change": "add x"}
    )
    assert d["state_id"] == "implementing"
    # the gap findings are injected into the next implement task
    assert "criterion 2 unmet" in d["task_summary"]


def test_verify_missing_passed_field_is_contract_violation(cp):
    _advance_to_plan_gate(cp)
    _step(cp, "user", {"user_response": "approve"})
    _step(cp, "skribble", {"confidence": "PROBABLE"})  # implementing -> verifying
    # verify SUMMARY missing required 'passed' -> bounded retry re-issues verifying
    d = _step(cp, "skribble", {"confidence": "PROBABLE", "evidence": ["x"]})
    assert d["action"] == "invoke_agent" and d["state_id"] == "verifying"


def test_verify_without_evidence_is_contract_violation(cp):
    # Externally-grounded VERIFY (Rec 4): a PASS with no captured evidence is a
    # contract violation and re-issues the verify step rather than advancing.
    _advance_to_plan_gate(cp)
    _step(cp, "user", {"user_response": "approve"})
    _step(cp, "skribble", {"confidence": "PROBABLE"})  # implementing -> verifying
    d = _step(cp, "skribble", {"passed": True, "confidence": "PROBABLE", "evidence": []})
    assert d["action"] == "invoke_agent" and d["state_id"] == "verifying"


def test_final_verify_loop_exhausts_honestly(cp):
    # DEFECT 1 (loop honesty): learn keeps reporting no gap while the FINAL
    # verify keeps failing (on DIFFERENT issues, so the no-progress stall guard
    # does not fire). The battery is BOUNDED — after FINAL_VERIFY_CAP attempts it
    # completes HONESTLY (met=False) with the unresolved failures reported,
    # rather than spinning to the global STEP_CAP with a generic error.
    _advance_to_learning(cp)
    assert _step(cp, "carren", {"gap": False})["state_id"] == "verifying"
    assert _step(cp, "skribble", _verify_fail("alpha"))["state_id"] == "learning"
    assert _step(cp, "carren", {"gap": False})["state_id"] == "verifying"
    assert _step(cp, "skribble", _verify_fail("beta"))["state_id"] == "learning"
    assert _step(cp, "carren", {"gap": False})["state_id"] == "verifying"
    assert _step(cp, "skribble", _verify_fail("gamma"))["state_id"] == "learning"
    # The battery is spent: the next no-gap learn does NOT request another final
    # verify — it completes honestly.
    d = _step(cp, "carren", {"gap": False})
    assert d["action"] == "complete"
    assert d["result"]["met"] is False
    assert d["result"]["verify_passed"] is False
    assert d["result"]["learn_gap"] is False
    assert d["result"]["final_verify_exhausted"] is True
    assert d["result"]["unresolved_failures"] == ["unresolved: gamma"]


def test_final_verify_stall_escalates_on_repeated_failures(cp):
    # DEFECT 1 (loop honesty): when the FINAL verify keeps failing on the SAME
    # issue while learn keeps reporting no gap, progress_check escalates the
    # learn/verify disagreement to the user — stall detection is NOT gated behind
    # gap truthiness. The run never spins to the global STEP_CAP.
    _advance_to_learning(cp)
    same = _verify_fail("same")
    d = None
    for _ in range(6):
        d = _step(cp, "carren", {"gap": False})
        if d["action"] == "escalate_to_user":
            break
        assert d["state_id"] == "verifying"
        assert _step(cp, "skribble", same)["state_id"] == "learning"
    assert d["action"] == "escalate_to_user"
    assert "disagreement" in d["unknown_reason"]


def test_repeated_retry_strategy_escalates(cp):
    # Anti-paralysis (Rec 1): a second retry that repeats the same strategy
    # escalates to the user instead of spinning through the budget.
    _advance_to_learning(cp)
    # iteration 0: gap with a strategy -> loops back to implementing
    assert (
        _step(cp, "carren", {"gap": True, "findings": ["slow"], "strategy_change": "add an index"})[
            "state_id"
        ]
        == "implementing"
    )
    _step(cp, "skribble", {"confidence": "PROBABLE"})  # implementing -> verifying
    _step(cp, "skribble", _VERIFY_PASS)  # verifying -> learning
    # iteration 1: same strategy -> escalate
    d = _step(
        cp, "carren", {"gap": True, "findings": ["still slow"], "strategy_change": "add an INDEX"}
    )
    assert d["action"] == "escalate_to_user"


# ---------------------------------------------------------------------------
# Recovery re-presents a pending gate
# ---------------------------------------------------------------------------


def test_recovery_re_presents_plan_gate(cp):
    from orchestration.recovery import recover_pending

    _advance_to_plan_gate(cp)
    directives = recover_pending(cp, session_id=SID, playbook="code")
    assert len(directives) == 1 and directives[0]["action"] == "escalate_to_user"
    assert directives[0]["previous_state"] == "plan_gate"
