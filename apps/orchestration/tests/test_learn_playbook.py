"""Integration tests for the learn skill (LearnPlaybook) on the engine.

Each step() constructs a FRESH playbook instance pointed at the same
checkpointer (subprocess-per-invocation reality). Exercises: the full happy
path (ingest fan-in → design → charter gate → per-lesson author/assess loops →
synthesize → verify → critique → complete), the charter gate's three routes
(approve/refine/deny), the bounded verify → fix loop with honest exhaustion
(met=False, never a fabricated pass), critique-driven fixes re-entering
verification, stall escalation on persisting violations, needs-clarification
escalation, and start() contract enforcement (source_dir required).
"""

import pytest

from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.playbooks.learn import LearnPlaybook

SID, RID = "sess-learn", "run-learn"

_CONSTRAINTS = {"source_dir": "/tmp/course-src", "output_dir": "/tmp/course-out"}

_DESIGN_OK = {
    "design_complete": True,
    "lesson_count": 2,
    "topic_count": 20,
    "conventions": ["uppercase Bell states", "top wire = q0 = rightmost"],
    "analogy_count": 15,
}
_AUTHOR_OK = lambda i: {  # noqa: E731
    "lesson_complete": True,
    "lesson_index": i,
    "files_written": [f"lesson{i}/study_guide/study_guide.md"],
}
_ASSESS_OK = lambda i: {  # noqa: E731
    "lesson_complete": True,
    "lesson_index": i,
    "files_written": [f"lesson{i}/exam/practice_exam.md"],
}
_SYNTH_OK = {"synthesis_complete": True, "files_written": ["final_prep/comprehensive_review.md"]}
_VERIFY_PASS = {"verified": True, "violations": [], "math_checked": True}
_APPROVE = {"verdict": "APPROVE", "issues": []}
_FIX_OK = {"fixes_complete": True, "fixed_count": 3}


def _verify_fail(*violations):
    return {"verified": False, "violations": list(violations), "math_checked": True}


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


def _start(cp, goal="Build a study companion for the quantum course", constraints=None):
    return LearnPlaybook(cp).start(
        session_id=SID,
        run_id=RID,
        goal=goal,
        constraints=dict(_CONSTRAINTS if constraints is None else constraints),
    )


def _step(cp, agent, result):
    return LearnPlaybook(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


def _ingest_batch(complete=True):
    return [
        {"branch_id": b, "agent": "echo", "exitCode": 0, "summary": {"explore_complete": complete}}
        for b in ("content", "conventions", "assessment")
    ]


def _to_gate(cp):
    _start(cp)
    _step(cp, "__parallel__", _ingest_batch())
    return _step(cp, "annie", _DESIGN_OK)


def _approve_gate(cp, directive=None):
    return LearnPlaybook(cp).step(
        session_id=SID, run_id=RID, agent="user", result={"user_response": "approve"}
    )


def _to_verifying(cp):
    _to_gate(cp)
    _approve_gate(cp)
    _step(cp, "skribble", _AUTHOR_OK(0))
    _step(cp, "skribble", _AUTHOR_OK(1))
    _step(cp, "skribble", _ASSESS_OK(0))
    _step(cp, "skribble", _ASSESS_OK(1))
    return _step(cp, "synthia", _SYNTH_OK)


# ---------------------------------------------------------------------------
# start() contract
# ---------------------------------------------------------------------------


def test_start_requires_source_dir(cp):
    d = _start(cp, constraints={})
    assert d["action"] == "error"
    assert any("source_dir" in str(e) for e in d["errors"])


def test_start_requires_goal(cp):
    d = _start(cp, goal="  ")
    assert d["action"] == "error"
    assert any("goal" in str(e) for e in d["errors"])


def test_start_dispatches_parallel_ingest(cp):
    d = _start(cp)
    assert d["action"] == "invoke_agents_parallel"
    assert {t["branch_id"] for t in d["tasks"]} == {"content", "conventions", "assessment"}


# ---------------------------------------------------------------------------
# happy path
# ---------------------------------------------------------------------------


def test_full_happy_path(cp):
    _to_verifying(cp)
    _step(cp, "vera", _VERIFY_PASS)
    d = _step(cp, "carren", _APPROVE)
    assert d["action"] == "complete"
    r = d["result"]
    assert r["met"] is True
    assert r["lesson_count"] == 2
    assert r["lessons_authored"] == 2
    assert r["lessons_assessed"] == 2
    assert r["verified_clean"] is True
    assert r["critique_verdict"] == "APPROVE"
    assert r["session_room"] == f"skills/learn-{SID}"


def test_authoring_loops_per_lesson(cp):
    _to_gate(cp)
    _approve_gate(cp)
    d = _step(cp, "skribble", _AUTHOR_OK(0))
    # 2 lessons -> after lesson 0 the engine re-dispatches authoring
    assert d["action"] == "invoke_agent"
    assert d["state_id"] == "authoring"
    d = _step(cp, "skribble", _AUTHOR_OK(1))
    assert d["state_id"] == "assessing"


# ---------------------------------------------------------------------------
# charter gate
# ---------------------------------------------------------------------------


def test_charter_gate_pauses_for_user(cp):
    d = _to_gate(cp)
    assert d["action"] == "escalate_to_user"
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER and rec.current_state_id == "charter_gate"


def test_charter_gate_refine_returns_to_designing(cp):
    _to_gate(cp)
    d = LearnPlaybook(cp).step(
        session_id=SID,
        run_id=RID,
        agent="user",
        result={"user_response": "use fewer lessons"},
    )
    assert d["action"] == "invoke_agent"
    assert d["state_id"] == "designing"
    assert "fewer lessons" in d["task_summary"]


def test_charter_gate_deny_terminates(cp):
    _to_gate(cp)
    d = LearnPlaybook(cp).step(
        session_id=SID, run_id=RID, agent="user", result={"user_response": "deny"}
    )
    assert d["action"] == "error"


# ---------------------------------------------------------------------------
# verify -> fix loop
# ---------------------------------------------------------------------------


def test_verify_fail_routes_to_fixing_then_reverifies(cp):
    _to_verifying(cp)
    d = _step(cp, "vera", _verify_fail("guide1: notation fork"))
    assert d["state_id"] == "fixing"
    assert "notation fork" in d["task_summary"]
    d = _step(cp, "skribble", _FIX_OK)
    assert d["state_id"] == "verifying"
    _step(cp, "vera", _VERIFY_PASS)
    d = _step(cp, "carren", _APPROVE)
    assert d["action"] == "complete"
    assert d["result"]["met"] is True
    assert d["result"]["iterations"] == 1


def test_verify_exhaustion_completes_honestly(cp):
    _to_verifying(cp)
    # max_iterations defaults to 3: rounds with DIFFERENT violations (no stall)
    for i in range(2):
        _step(cp, "vera", _verify_fail(f"round-{i}: distinct violation {i}"))
        _step(cp, "skribble", _FIX_OK)
    d = _step(cp, "vera", _verify_fail("final: still broken"))
    assert d["action"] == "complete"
    r = d["result"]
    assert r["met"] is False
    assert r["exhausted"] is True
    assert r["unresolved_violations"] == ["final: still broken"]


def test_verify_stall_escalates(cp):
    _to_verifying(cp)
    same = "guide1: same persistent violation"
    # is_stalled(window=2) needs two recorded rounds with identical gaps
    _step(cp, "vera", _verify_fail(same))
    _step(cp, "skribble", _FIX_OK)
    _step(cp, "vera", _verify_fail(same))
    _step(cp, "skribble", _FIX_OK)
    d = _step(cp, "vera", _verify_fail(same))
    # identical violations across rounds -> stall -> escalate, not exhaust/loop
    assert d["action"] == "escalate_to_user"


# ---------------------------------------------------------------------------
# critique routes
# ---------------------------------------------------------------------------


def test_critique_needs_revision_routes_to_fixing(cp):
    _to_verifying(cp)
    _step(cp, "vera", _VERIFY_PASS)
    d = _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["lesson 2: analogy drift"]})
    assert d["state_id"] == "fixing"
    assert "analogy drift" in d["task_summary"]
    # fixes re-verify before any completion
    d = _step(cp, "skribble", _FIX_OK)
    assert d["state_id"] == "verifying"


def test_critique_exhaustion_completes_honestly(cp):
    _to_verifying(cp)
    _step(cp, "vera", _VERIFY_PASS)
    for i in range(2):
        _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": [f"issue {i}"]})
        _step(cp, "skribble", _FIX_OK)
        _step(cp, "vera", _VERIFY_PASS)
    d = _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["issue final"]})
    assert d["action"] == "complete"
    assert d["result"]["met"] is False
    assert d["result"]["exhausted"] is True


# ---------------------------------------------------------------------------
# escalation
# ---------------------------------------------------------------------------


def test_needs_clarification_escalates(cp):
    _to_gate(cp)
    _approve_gate(cp)
    d = _step(
        cp,
        "skribble",
        {
            "lesson_complete": False,
            "lesson_index": 0,
            "needs_clarification": True,
            "clarifying_questions": ["Which exam format should lesson 1 target?"],
        },
    )
    assert d["action"] == "escalate_to_user"
    assert any("exam format" in str(q) for q in d.get("questions", []))
