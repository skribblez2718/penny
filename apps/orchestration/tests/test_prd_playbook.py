"""Integration tests for the migrated prd skill (PrdPlaybook) on the engine.

Exercises the clarify-first HITL flow (first generate = CLARIFICATION QUESTIONS
mode, escalation with synthia's questions, clarify-resume into SYNTHESIS mode),
the vera revision loop with honest exhaustion (no force-valid at the cap), stall
escalation, UNCERTAIN escalation from vera (a legacy dead-end, now coherent), and
the run_id/checkpointer contract (fresh instance per step).
"""

import pytest

from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.context import RunContext
from orchestration.playbooks.prd import PRD_GENERATE, PrdPlaybook, available_domains

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
    "domain": "web-app",  # synthia declares the best-fit pack (model-owned, R1)
    "requirement_count": 12,
    "narrative_sections": 12,
    "verification_matrix_complete": True,
    "ideal_state_valid": True,
    "needs_clarification": False,
    "clarifying_questions": [],
    "confidence": "PROBABLE",
}
# vera is evidence-gated (Rec 4): every verdict carries captured evidence.
VERA_PASS = {
    "valid": True,
    "ideal_state_valid": True,
    "issues": [],
    "evidence": ["validate_ideal_state: OK", "12/12 narrative sections found"],
    "confidence": "CERTAIN",
}


def _vera_fail(issues):
    return {
        "valid": False,
        "ideal_state_valid": False,
        "issues": issues,
        "evidence": ["schema check ran", "section audit ran"],
        "confidence": "PROBABLE",
    }


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


def _start(cp, goal=GOAL, constraints=None, cls=PrdPlaybook):
    return cls(cp).start(
        session_id=SID, run_id=RID, goal=goal, constraints=constraints or {}
    )


def _step(cp, agent, result, cls=PrdPlaybook):
    return cls(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


def _to_validating(cp, constraints=None, cls=PrdPlaybook):
    """Walk the canonical clarify-first path up to the first vera dispatch."""
    _start(cp, constraints=constraints, cls=cls)
    _step(cp, "synthia", CLARIFY_SUMMARY, cls=cls)  # -> escalate with questions
    _step(cp, "user", {"answer": "internal ops team; ~10k documents"}, cls=cls)  # -> SYNTHESIS
    _step(cp, "synthia", SYNTH_SUMMARY, cls=cls)  # -> validating


class _MalformedIdealPrd(PrdPlaybook):
    """PrdPlaybook whose IDEAL_STATE read returns a schema-MALFORMED spec (missing the
    required fields), so the T4 code schema-floor must reject it regardless of vera."""

    def _read_ideal_state(self, ctx):
        return {"goal": "x"}  # not a valid IdealState -> validate_json fails


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


def test_first_task_lists_available_packs_for_model_choice(cp):
    # No caller domain: the first task lists the packs and asks the model to
    # declare one — no keyword detection.
    d = _start(cp)
    assert "Available domain guidance packs" in d["task_summary"]
    assert "web-app" in d["task_summary"] and "generic" in d["task_summary"]
    assert "Domain:" not in d["task_summary"]  # unresolved until declared


def test_available_domains_includes_generic_and_web_app():
    ctx = RunContext(session_id=SID, run_id=RID, playbook="prd", goal=GOAL)
    names = available_domains(ctx)
    assert "generic" in names and "web-app" in names


def test_caller_domain_constraint_wins_and_is_not_overridden(cp):
    d = _start(cp, constraints={"domain": "web-app"})
    assert "Domain: web-app" in d["task_summary"]
    _step(cp, "synthia", CLARIFY_SUMMARY)
    _step(cp, "user", {"answer": "ops"})
    _step(cp, "synthia", {**SYNTH_SUMMARY, "domain": "generic"})  # model tries to differ
    assert cp.load(RID).context.extras["prd"]["domain"] == "web-app"


def test_model_declared_domain_is_captured(cp):
    _to_validating(cp)  # SYNTH_SUMMARY declares web-app
    assert cp.load(RID).context.extras["prd"]["domain"] == "web-app"


def test_unknown_declared_domain_falls_back_to_generic(cp):
    _start(cp)
    _step(cp, "synthia", CLARIFY_SUMMARY)
    _step(cp, "user", {"answer": "ops"})
    _step(cp, "synthia", {**SYNTH_SUMMARY, "domain": "not-a-real-pack"})
    assert cp.load(RID).context.extras["prd"]["domain"] == "generic"


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
            "evidence": ["cross-artifact audit ran"],
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


# ---------------------------------------------------------------------------
# evidence-gated validation (Rec 4) + recall injection (R5.5)
# ---------------------------------------------------------------------------


def test_validate_rejects_empty_evidence_then_accepts_grounded(cp):
    _to_validating(cp)
    # PASS with EMPTY evidence violates the contract -> bounded retry, not a pass.
    d = _step(
        cp,
        "vera",
        {
            "valid": True,
            "ideal_state_valid": True,
            "issues": [],
            "evidence": [],
            "confidence": "CERTAIN",
        },
    )
    assert d["action"] == "invoke_agent" and d["state_id"] == "validating"
    # With captured evidence it passes.
    d2 = _step(cp, "vera", VERA_PASS)
    assert d2["action"] == "complete" and d2["result"]["met"] is True


def test_validate_evidence_lands_on_context(cp):
    _to_validating(cp)
    _step(cp, "vera", VERA_PASS)
    assert cp.load(RID).context.verify_evidence  # captured for the outcome ledger


def test_recall_lessons_render_in_first_directive(cp):
    pb = PrdPlaybook(cp)
    ctx = RunContext(session_id=SID, run_id=RID, playbook="prd", goal=GOAL)
    ctx.recall_lessons = ["prefer measurable, testable success criteria"]
    ctx.extras["prd"] = {"mode": "clarification", "domain": "", "available_domains": ["generic"]}
    txt = pb._task_summary("generating", PRD_GENERATE, ctx)
    assert "Lessons from prior runs" in txt
    assert "prefer measurable, testable success criteria" in txt


# ---------------------------------------------------------------------------
# T4: deterministic IDEAL_STATE schema-floor beneath vera's judgement
# ---------------------------------------------------------------------------


def test_schema_check_rejects_malformed_and_skips_unreadable(cp):
    from orchestration.context import RunContext

    ctx = RunContext(session_id=SID, run_id=RID, playbook="prd")
    ok, errors = _MalformedIdealPrd(cp)._schema_check_ideal_state(ctx)
    assert ok is False and errors  # malformed -> rejected by code, with errors
    # default read is None under pytest -> the floor is skipped (vera stands)
    assert PrdPlaybook(cp)._schema_check_ideal_state(ctx) == (None, [])


def test_schema_floor_overrides_vera_pass_on_malformed_ideal_state(cp):
    # vera PASSes (valid + ideal_state_valid True), but the code schema-floor finds the
    # IDEAL_STATE malformed -> the run does NOT complete; it revises. A schema-malformed
    # spec can never pass on vera's say-so.
    _to_validating(cp, cls=_MalformedIdealPrd)
    d = _step(cp, "vera", VERA_PASS, cls=_MalformedIdealPrd)
    assert d["action"] == "invoke_agent" and d["state_id"] == "generating"  # forced revise
    prd = cp.load(RID).context.extras["prd"]
    assert prd["ideal_state_valid"] is False  # code floor overrode vera's PASS
    assert prd.get("schema_evidence")  # deterministic schema errors captured as evidence


def test_schema_floor_skipped_when_unreadable_lets_vera_pass(cp):
    # Unreadable IDEAL_STATE (pytest-hermetic default) -> floor skipped, vera's PASS stands.
    _to_validating(cp)
    d = _step(cp, "vera", VERA_PASS)
    assert d["action"] == "complete"
    assert cp.load(RID).context.extras["prd"]["schema_checked"] is False
