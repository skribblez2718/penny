"""Integration tests for the migrated prd skill (PrdPlaybook) on the engine.

Exercises the clarify-first HITL flow (first generate = CLARIFICATION QUESTIONS
mode, escalation with synthia's questions, clarify-resume into SYNTHESIS mode),
the vera revision loop with honest exhaustion (no force-valid at the cap), stall
escalation, UNCERTAIN escalation from vera (a legacy dead-end, now coherent), and
the run_id/checkpointer contract (fresh instance per step).
"""

import pytest

from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.playbooks.prd import PrdPlaybook, detect_domain

SID, RID = "sess-prd", "run-prd"
GOAL = "build a fastapi service for document search"

CLARIFY_SUMMARY = {
    "complete": True,
    "requirement_count": 0,
    "narrative_sections": 0,
    "verification_matrix_complete": False,
    "ideal_state_valid": False,
    "needs_clarification": True,
    "clarifying_questions": ["Who are the users?", "What scale of documents?"],
    "confidence": "PROBABLE",
}
SYNTH_SUMMARY = {
    "complete": True,
    "requirement_count": 12,
    "narrative_sections": 12,
    "verification_matrix_complete": True,
    "ideal_state_valid": True,
    "needs_clarification": False,
    "clarifying_questions": [],
    "confidence": "PROBABLE",
}
VERA_PASS = {"valid": True, "ideal_state_valid": True, "issues": [], "confidence": "CERTAIN"}


def _vera_fail(issues):
    return {"valid": False, "ideal_state_valid": False, "issues": issues, "confidence": "PROBABLE"}


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


def _start(cp, goal=GOAL, constraints=None):
    return PrdPlaybook(cp).start(
        session_id=SID, run_id=RID, goal=goal, constraints=constraints or {}
    )


def _step(cp, agent, result):
    return PrdPlaybook(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


def _to_validating(cp, constraints=None):
    """Walk the canonical clarify-first path up to the first vera dispatch."""
    _start(cp, constraints=constraints)
    _step(cp, "synthia", CLARIFY_SUMMARY)  # -> escalate with questions
    _step(cp, "user", {"answer": "internal ops team; ~10k documents"})  # -> SYNTHESIS
    _step(cp, "synthia", SYNTH_SUMMARY)  # -> validating


# ---------------------------------------------------------------------------
# start + clarify-first dispatch
# ---------------------------------------------------------------------------


def test_start_requires_goal(cp):
    d = PrdPlaybook(cp).start(session_id=SID, run_id=RID, goal="   ")
    assert d["action"] == "error"


def test_start_dispatches_clarification_mode(cp):
    d = _start(cp)
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "synthia" and d["state_id"] == "generating"
    assert d["run_id"] == RID and "orchestrator_state" not in d
    assert "Mode: CLARIFICATION QUESTIONS" in d["task_summary"]
    # room contract the code skill depends on
    assert f"skills/prd-{SID}" in d["task_summary"]
    assert "wing=penny" in d["task_summary"]


def test_domain_detection_folded_into_start(cp):
    # keyword goal -> web-app; the vestigial echo classify state is gone
    assert detect_domain(GOAL) == "web-app"
    assert detect_domain("summarize quarterly sales numbers") == "generic"
    d = _start(cp)
    assert "Domain: web-app" in d["task_summary"]


def test_max_iterations_defaults_to_legacy_five(cp):
    _start(cp)
    assert cp.load(RID).context.max_iterations == 5


def test_max_iterations_constraint_overrides_default(cp):
    _start(cp, constraints={"max_iterations": 2})
    assert cp.load(RID).context.max_iterations == 2


# ---------------------------------------------------------------------------
# clarify-first HITL: escalation with synthia's questions + SYNTHESIS resume
# ---------------------------------------------------------------------------


def test_needs_clarification_escalates_with_questions(cp):
    _start(cp)
    d = _step(cp, "synthia", CLARIFY_SUMMARY)
    assert d["action"] == "escalate_to_user"
    assert "Who are the users?" in d["unknown_reason"]
    # escalation question shape the extension's questionnaire builder needs
    assert d["questions"][0]["options"] == [] and d["questions"][0]["allowOther"] is True
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER
    assert rec.current_state_id == "awaiting_clarification"


def test_clarify_resumes_in_synthesis_mode(cp):
    _start(cp)
    _step(cp, "synthia", CLARIFY_SUMMARY)
    d = _step(cp, "user", {"answer": "internal ops team"})
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "synthia" and d["state_id"] == "generating"
    assert "Mode: SYNTHESIS" in d["task_summary"]
    assert "User clarification: internal ops team" in d["task_summary"]


def test_clarification_pass_without_questions_self_loops_to_synthesis(cp):
    # A clarification pass that produced neither questions nor artifacts must
    # dispatch a full synthesis, not send vera an empty room.
    _start(cp)
    d = _step(
        cp,
        "synthia",
        {"complete": True, "requirement_count": 0, "needs_clarification": False},
    )
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "synthia" and d["state_id"] == "generating"
    assert "Mode: SYNTHESIS" in d["task_summary"]


# ---------------------------------------------------------------------------
# happy path: synthesis -> vera -> complete
# ---------------------------------------------------------------------------


def test_synthesis_routes_to_vera(cp):
    _to_validating(cp)
    rec = cp.load(RID)
    assert rec.current_state_id == "validating"
    # the pending directive was for vera with the artifact-read instructions
    d = _step(cp, "vera", _vera_fail(["Section 7 NFRs missing thresholds"]))
    assert d["agent"] == "synthia"  # fail loops back (proves vera was consumed)


def test_validation_pass_completes_with_prd_summary(cp):
    _to_validating(cp)
    d = _step(cp, "vera", VERA_PASS)
    assert d["action"] == "complete"
    assert d["result"]["met"] is True
    ps = d["result"]["prd_summary"]
    assert ps["goal"] == GOAL and ps["domain"] == "web-app"
    assert ps["requirement_count"] == 12 and ps["narrative_sections"] == 12
    assert ps["verification_matrix_complete"] is True and ps["ideal_state_valid"] is True
    assert ps["session_id"] == SID and ps["requires_approval"] is True
    assert d["result"]["session_room"] == f"skills/prd-{SID}"
    assert d["result"]["mempalace_drawers"] == {"wing": "penny", "room": f"skills/prd-{SID}"}
    assert d["result"]["exhausted"] is False and d["result"]["unresolved_issues"] == []


# ---------------------------------------------------------------------------
# revision loop + honest exhaustion (no force-valid at the cap)
# ---------------------------------------------------------------------------


def test_validation_failure_dispatches_revision_mode(cp):
    _to_validating(cp)
    d = _step(cp, "vera", _vera_fail(["REQ-005 lacks acceptance criteria"]))
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "synthia" and d["state_id"] == "generating"
    assert "Mode: REVISION" in d["task_summary"]
    assert "REQ-005 lacks acceptance criteria" in d["task_summary"]


def test_exhaustion_completes_honestly_not_forced_valid(cp):
    # A perpetually-failing validation with CHANGING issues walks the budget and
    # completes with met=False + unresolved issues — never a fabricated valid=True.
    _to_validating(cp, constraints={"max_iterations": 2})
    d = _step(cp, "vera", _vera_fail(["issue a"]))  # iter 0 -> revise
    assert d["state_id"] == "generating"
    _step(cp, "synthia", SYNTH_SUMMARY)  # revision -> validating
    d2 = _step(cp, "vera", _vera_fail(["issue b"]))  # iter 1 -> budget spent
    assert d2["action"] == "complete"
    assert d2["result"]["met"] is False
    assert d2["result"]["exhausted"] is True
    assert d2["result"]["unresolved_issues"] == ["issue b"]
    assert d2["result"]["prd_summary"]["ideal_state_valid"] is False


def test_stalled_revisions_escalate_instead_of_spinning(cp):
    # Same issue every round -> stall detector escalates rather than burning the
    # remaining budget (default max_iterations 5).
    _to_validating(cp)
    _step(cp, "vera", _vera_fail(["same problem"]))  # iter 0 -> revise
    _step(cp, "synthia", SYNTH_SUMMARY)
    _step(cp, "vera", _vera_fail(["same problem"]))  # iter 1 -> revise
    _step(cp, "synthia", SYNTH_SUMMARY)
    d = _step(cp, "vera", _vera_fail(["same problem"]))  # iter 2 -> stall
    assert d["action"] == "escalate_to_user"
    assert "no measurable progress" in d["unknown_reason"]


# ---------------------------------------------------------------------------
# UNCERTAIN escalation (fix vs. legacy: vera UNCERTAIN was a dead-end error)
# ---------------------------------------------------------------------------


def test_vera_uncertain_escalates_and_resumes_generation(cp):
    _to_validating(cp)
    d = _step(
        cp,
        "vera",
        {
            "valid": False,
            "ideal_state_valid": False,
            "issues": ["contradictory artifacts"],
            "confidence": "UNCERTAIN",
        },
    )
    assert d["action"] == "escalate_to_user"
    assert d["previous_state"] == "validating"
    # legacy drove the FSM into terminal error here; the engine port resumes
    d2 = _step(cp, "user", {"answer": "drop the offline mode requirement"})
    assert d2["action"] == "invoke_agent"
    assert d2["agent"] == "synthia" and d2["state_id"] == "generating"


def test_synthia_uncertain_escalates(cp):
    _start(cp)
    d = _step(cp, "synthia", {"complete": True, "confidence": "UNCERTAIN"})
    assert d["action"] == "escalate_to_user"
    assert d["previous_state"] == "generating"


# ---------------------------------------------------------------------------
# SUMMARY contract enforcement
# ---------------------------------------------------------------------------


def test_malformed_generate_summary_is_retried(cp):
    _start(cp)
    # missing required 'complete' -> bounded retry re-issues generating
    d = _step(cp, "synthia", {"requirement_count": 3})
    assert d["action"] == "invoke_agent" and d["state_id"] == "generating"


def test_malformed_validate_summary_is_retried(cp):
    _to_validating(cp)
    # missing required 'valid' -> bounded retry re-issues validating
    d = _step(cp, "vera", {"issues": []})
    assert d["action"] == "invoke_agent" and d["state_id"] == "validating"


def test_wrong_agent_for_state_errors(cp):
    _start(cp)
    d = _step(cp, "vera", VERA_PASS)
    assert d["action"] == "error"


# ---------------------------------------------------------------------------
# recovery re-presents a pending clarification
# ---------------------------------------------------------------------------


def test_recovery_re_presents_pending_clarification(cp, monkeypatch):
    import orchestration.playbooks as playbooks
    from orchestration.recovery import recover_pending

    monkeypatch.setitem(playbooks.PLAYBOOKS, "prd", PrdPlaybook)
    _start(cp)
    _step(cp, "synthia", CLARIFY_SUMMARY)  # -> awaiting_clarification
    directives = recover_pending(cp, session_id=SID, playbook="prd")
    assert len(directives) == 1 and directives[0]["action"] == "escalate_to_user"
    assert directives[0]["previous_state"] == "generating"
    assert "Who are the users?" in directives[0]["unknown_reason"]


def test_detect_domain_lit_substring_no_false_positive():
    """'lit' must NOT be a bare keyword — 'quality' contains the substring 'lit'."""
    assert detect_domain("improve code quality") == "generic"
    assert detect_domain("audit reliability and stability") == "generic"


def test_detect_domain_recognizes_lit_and_tailwind():
    """Precise Lit tokens and Tailwind are recognized as web-app."""
    assert detect_domain("build a litelement design system") == "web-app"
    assert detect_domain("refactor the lit-html templates") == "web-app"
    assert detect_domain("style the panel with tailwind") == "web-app"
