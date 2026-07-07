"""Integration tests for the migrated plan skill (PlanPlaybook) on the engine.

Exercises the parallel exploration fan-out, the plan → critique → taskify flow,
the conditional high-stakes verification gate, the bounded revision loop with
honest exhaustion (no force-APPROVE), needs-clarification escalation, and the
run_id/checkpointer contract (fresh instance per step).
"""

import pytest

from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.playbooks.plan import PlanPlaybook

SID, RID = "sess-plan", "run-plan"


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


def _start(cp, goal="add pagination to the API", constraints=None):
    return PlanPlaybook(cp).start(
        session_id=SID, run_id=RID, goal=goal, constraints=constraints or {}
    )


def _step(cp, agent, result):
    return PlanPlaybook(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


def _explore_batch(complete=True):
    return [
        {"branch_id": b, "agent": "echo", "exitCode": 0, "summary": {"explore_complete": complete}}
        for b in ("entrypoints", "tests", "config")
    ]


def _fan_in(cp):
    return _step(cp, "__parallel__", _explore_batch())


def _explore_batch_with_clarification():
    """One branch (entrypoints) needs clarification and honestly reports
    UNCERTAIN confidence; the other two complete normally."""
    batch = _explore_batch()
    batch[0]["summary"] = {
        "explore_complete": False,
        "needs_clarification": True,
        "clarifying_questions": ["monolith or microservices target?"],
        "confidence": "UNCERTAIN",
    }
    return batch


# ---------------------------------------------------------------------------
# start + parallel exploration
# ---------------------------------------------------------------------------


def test_start_requires_goal(cp):
    d = PlanPlaybook(cp).start(session_id=SID, run_id=RID, goal="  ")
    assert d["action"] == "error"


def test_start_fans_out_three_explore_branches(cp):
    d = _start(cp)
    assert d["action"] == "invoke_agents_parallel" and d["state_id"] == "exploring"
    assert {t["branch_id"] for t in d["tasks"]} == {"entrypoints", "tests", "config"}
    assert all(t["agent"] == "echo" for t in d["tasks"])
    # each branch carries its own focus + the shared mempalace room
    joined = " ".join(t["task_summary"] for t in d["tasks"])
    assert "entry points and call graph" in joined
    assert "skills/plan-" + SID in joined


def test_explore_fan_in_routes_to_planning(cp):
    _start(cp)
    d = _fan_in(cp)
    assert d["action"] == "invoke_agent" and d["agent"] == "piper" and d["state_id"] == "planning"


def test_explore_branch_clarification_escalates(cp):
    # A single explore branch flagging needs_clarification + UNCERTAIN confidence
    # must pause the whole run for the user rather than being silently dropped
    # (exploring is escalatable; the weakest-branch confidence aggregates to
    # UNCERTAIN and drives the engine's escalation path).
    _start(cp)
    d = _step(cp, "__parallel__", _explore_batch_with_clarification())
    assert d["action"] == "escalate_to_user"
    assert d["previous_state"] == "exploring"
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER
    assert rec.current_state_id == "awaiting_clarification"


def test_explore_clarification_resumes_at_exploring(cp):
    # After the user answers the branch's clarification, the run re-explores.
    _start(cp)
    _step(cp, "__parallel__", _explore_batch_with_clarification())
    d = _step(cp, "user", {"answer": "target the monolith"})
    assert d["action"] == "invoke_agents_parallel" and d["state_id"] == "exploring"


# ---------------------------------------------------------------------------
# happy path: relaxed mode skips the verify gate
# ---------------------------------------------------------------------------


def _advance_to_planning(cp, constraints=None):
    _start(cp, constraints=constraints)
    _fan_in(cp)


def test_relaxed_mode_skips_verify_gate(cp):
    _advance_to_planning(cp)
    # default (relaxed) verification mode -> straight to critiquing, no gate
    d = _step(cp, "piper", {"plan_complete": True, "plan_steps": [{"step": 1}], "stakes": "high"})
    assert (
        d["action"] == "invoke_agent" and d["agent"] == "carren" and d["state_id"] == "critiquing"
    )


def test_full_happy_path_to_complete(cp):
    _advance_to_planning(cp)
    _step(cp, "piper", {"plan_complete": True, "plan_steps": [{"step": 1}], "stakes": "low"})
    assert _step(cp, "carren", {"verdict": "APPROVE", "issues": []})["state_id"] == "taskifying"
    d = _step(cp, "tabitha", {"title": "Pagination Plan", "step_count": 4, "complete": True})
    assert d["action"] == "complete"
    assert d["result"]["met"] is True and d["result"]["critique_passed"] is True
    assert d["result"]["step_count"] == 4


# ---------------------------------------------------------------------------
# high-stakes verification gate (default mode)
# ---------------------------------------------------------------------------


def test_high_stakes_opens_verify_gate(cp):
    _advance_to_planning(cp, constraints={"verification_mode": "default"})
    d = _step(cp, "piper", {"plan_complete": True, "plan_steps": [{"step": 1}], "stakes": "high"})
    assert d["action"] == "escalate_to_user" and d["previous_state"] == "verify_gate"
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER and rec.current_state_id == "verify_gate"


def test_verify_confirm_proceeds_to_critique(cp):
    _advance_to_planning(cp, constraints={"verification_mode": "default"})
    _step(cp, "piper", {"plan_complete": True, "plan_steps": [{"step": 1}], "stakes": "high"})
    d = _step(cp, "user", {"user_response": "confirm"})
    assert d["state_id"] == "critiquing"


def test_verify_revise_returns_to_planning(cp):
    _advance_to_planning(cp, constraints={"verification_mode": "default"})
    _step(cp, "piper", {"plan_complete": True, "plan_steps": [{"step": 1}], "stakes": "high"})
    d = _step(cp, "user", {"user_response": "use a cursor instead"})
    assert d["state_id"] == "planning"


# ---------------------------------------------------------------------------
# revision loop + honest exhaustion (no force-APPROVE)
# ---------------------------------------------------------------------------


def _to_critiquing(cp):
    _advance_to_planning(cp)
    _step(cp, "piper", {"plan_complete": True, "plan_steps": [{"step": 1}], "stakes": "low"})


def test_critique_revision_loops_back_to_exploring(cp):
    _to_critiquing(cp)
    # first rejection with fresh issues -> re-explore (more context)
    d = _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["missing rollback step"]})
    assert d["action"] == "invoke_agents_parallel" and d["state_id"] == "exploring"


def test_exhaustion_completes_honestly_not_forced_approve(cp):
    # A perpetually-rejecting critique with CHANGING issues walks the budget and
    # completes with met=False + unresolved issues — never a fabricated APPROVE.
    _to_critiquing(cp)
    # iter 0 -> re-explore
    _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["issue a"]})
    _fan_in(cp)
    _step(cp, "piper", {"plan_complete": True, "plan_steps": [{"step": 1}]})
    # iter 1 -> re-explore
    _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["issue b"]})
    _fan_in(cp)
    _step(cp, "piper", {"plan_complete": True, "plan_steps": [{"step": 1}]})
    # iter 2 -> budget spent (max_iterations default 3) -> taskify honestly
    d = _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["issue c"]})
    assert d["action"] == "invoke_agent" and d["agent"] == "tabitha"
    d2 = _step(cp, "tabitha", {"title": "Best-effort plan", "step_count": 2, "complete": True})
    assert d2["action"] == "complete"
    assert d2["result"]["met"] is False
    assert d2["result"]["exhausted"] is True
    assert d2["result"]["unresolved_issues"] == ["issue c"]


def test_blocked_critique_halts_honestly_not_taskified(cp):
    # A BLOCKED (categorically-unsafe) plan must NOT be retried or taskified. The
    # run halts honestly at complete with met=False and the blocking issues
    # surfaced — never routed through tabitha.
    _to_critiquing(cp)
    d = _step(cp, "carren", {"verdict": "BLOCKED", "issues": ["drops the prod database"]})
    assert d["action"] == "complete"
    assert d["result"]["met"] is False
    assert d["result"]["blocked"] is True
    assert d["result"]["critique_passed"] is False
    assert d["result"]["unresolved_issues"] == ["drops the prod database"]
    # the run is terminal; tabitha was never invoked
    rec = cp.load(RID)
    assert rec.current_state_id == "complete"


def test_stalled_critique_escalates_instead_of_spinning(cp):
    # Same issue every round -> stall detector escalates rather than force-approve.
    _to_critiquing(cp)
    _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["same problem"]})  # iter 0
    _fan_in(cp)
    _step(cp, "piper", {"plan_complete": True, "plan_steps": [{"step": 1}]})
    _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["same problem"]})  # iter 1
    _fan_in(cp)
    _step(cp, "piper", {"plan_complete": True, "plan_steps": [{"step": 1}]})
    d = _step(
        cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["same problem"]}
    )  # iter 2 stall
    assert d["action"] == "escalate_to_user"
    assert "no measurable progress" in d["unknown_reason"]


# ---------------------------------------------------------------------------
# needs_clarification escalation + resume
# ---------------------------------------------------------------------------


def test_planner_needs_clarification_escalates(cp):
    _advance_to_planning(cp)
    d = _step(
        cp,
        "piper",
        {
            "plan_complete": True,
            "plan_steps": [{"step": 1}],
            "needs_clarification": True,
            "clarifying_questions": ["monolith or microservices?"],
        },
    )
    assert d["action"] == "escalate_to_user"
    assert "monolith or microservices?" in d["unknown_reason"]


def test_clarify_resumes_at_exploring(cp):
    _advance_to_planning(cp)
    _step(
        cp,
        "piper",
        {"plan_complete": True, "plan_steps": [{"step": 1}], "needs_clarification": True},
    )
    d = _step(cp, "user", {"answer": "target the monolith"})
    assert d["action"] == "invoke_agents_parallel" and d["state_id"] == "exploring"


# ---------------------------------------------------------------------------
# recovery re-presents a pending verify gate
# ---------------------------------------------------------------------------


def test_recovery_re_presents_verify_gate(cp):
    from orchestration.recovery import recover_pending

    _advance_to_planning(cp, constraints={"verification_mode": "default"})
    _step(cp, "piper", {"plan_complete": True, "plan_steps": [{"step": 1}], "stakes": "high"})
    directives = recover_pending(cp, session_id=SID, playbook="plan")
    assert len(directives) == 1 and directives[0]["action"] == "escalate_to_user"
    assert directives[0]["previous_state"] == "verify_gate"
