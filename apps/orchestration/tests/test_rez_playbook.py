"""Integration tests for the rez skill (RezPlaybook) on the engine.

Exercises the linear five-lane pipeline (analyzing→aligning→tailoring→
validating→exporting), the skill's hard guarantees (no JD / no base resume →
error; no accomplishments → proceed; NIST down → UNALIGNED degraded run;
export failure → error with no fallback), the bounded tailor⇄validate revision
loop with honest exhaustion (no export of an unverified resume), stall +
UNCERTAIN escalation, and the run_id/checkpointer contract.
"""

import pytest

from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.context import RunContext
from orchestration.playbooks.rez import (
    EXPORT_ERROR,
    NO_JD_ERROR,
    NO_RESUME_ERROR,
    REZ_ANALYZE,
    RezPlaybook,
)

SID, RID = "sess-rez", "run-rez"
GOAL = "https://jobs.example.com/postings/senior-appsec-engineer"

ANALYZE_OK = {
    "complete": True,
    "jd_loaded": True,
    "base_resume_found": True,
    "accomplishments_found": True,
    "company": "ExampleCorp",
    "role": "Senior AppSec Engineer",
    "match_count": 9,
    "miss_count": 2,
    "transferable_count": 3,
    "confidence": "PROBABLE",
}
ALIGN_OK = {
    "complete": True,
    "nice_available": True,
    "nice_version": "2.2.0 (2026-04-28)",
    "work_roles": ["PD-WRL-004 Vulnerability Analysis"],
    "confidence": "CERTAIN",
}
ALIGN_DOWN = {"complete": True, "nice_available": False, "confidence": "PROBABLE"}
TAILOR_OK = {"complete": True, "bullet_count": 14, "confidence": "PROBABLE"}
VERA_PASS = {
    "valid": True,
    "fabrication_free": True,
    "issues": [],
    "evidence": ["bullet 1→source line 4", "STAR ok", "ATS clean"],
    "star_compliant": True,
    "ats_ok": True,
    "confidence": "CERTAIN",
}
EXPORT_OK = {
    "export_ok": True,
    "word_extension_available": True,
    "output_path": "/tmp/resumes/K_Sketch_ExampleCorp_AppSec_2026-07-09.docx",
    "confidence": "CERTAIN",
}


def _vera_fail(issues, fabrication_free=False):
    return {
        "valid": False,
        "fabrication_free": fabrication_free,
        "issues": issues,
        "evidence": ["traced every bullet to sources"],
        "confidence": "PROBABLE",
    }


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


def _start(cp, goal=GOAL, constraints=None):
    return RezPlaybook(cp).start(
        session_id=SID, run_id=RID, goal=goal, constraints=constraints or {}
    )


def _step(cp, agent, result):
    return RezPlaybook(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


def _to_validating(cp, constraints=None, align=ALIGN_OK):
    _start(cp, constraints=constraints)
    _step(cp, "annie", ANALYZE_OK)
    _step(cp, "echo", align)
    _step(cp, "synthia", TAILOR_OK)


# ---------------------------------------------------------------------------
# start + input validation
# ---------------------------------------------------------------------------


def test_start_requires_jd_goal(cp):
    d = RezPlaybook(cp).start(session_id=SID, run_id=RID, goal="   ")
    assert d["action"] == "error"


def test_start_dispatches_analyzing(cp):
    d = _start(cp)
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "annie" and d["state_id"] == "analyzing"
    assert d["run_id"] == RID and "orchestrator_state" not in d
    assert GOAL in d["task_summary"]
    assert f"skills/rez-{SID}" in d["task_summary"]
    assert "wing=penny" in d["task_summary"]
    assert "READ-ONLY" in d["task_summary"]


def test_max_iterations_defaults_to_three(cp):
    _start(cp)
    assert cp.load(RID).context.max_iterations == 3


def test_max_iterations_constraint_overrides_default(cp):
    _start(cp, constraints={"max_iterations": 2})
    assert cp.load(RID).context.max_iterations == 2


def test_unusable_jd_aborts_with_canonical_error(cp):
    _start(cp)
    d = _step(cp, "annie", {**ANALYZE_OK, "jd_loaded": False})
    assert d["action"] == "error"
    assert NO_JD_ERROR in str(d)


def test_missing_base_resume_aborts_with_canonical_error(cp):
    _start(cp)
    d = _step(cp, "annie", {**ANALYZE_OK, "base_resume_found": False})
    assert d["action"] == "error"
    assert NO_RESUME_ERROR in str(d)


def test_missing_accomplishments_proceeds(cp):
    _start(cp)
    d = _step(cp, "annie", {**ANALYZE_OK, "accomplishments_found": False})
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "echo" and d["state_id"] == "aligning"


# ---------------------------------------------------------------------------
# fresh NICE lookup lane
# ---------------------------------------------------------------------------


def test_align_task_demands_fresh_lookup(cp):
    _start(cp)
    d = _step(cp, "annie", ANALYZE_OK)
    assert d["agent"] == "echo" and d["state_id"] == "aligning"
    assert "nice-framework-current-versions" in d["task_summary"]
    assert "never rely on cached" in d["task_summary"].lower()


def test_nice_down_proceeds_unaligned(cp):
    _start(cp)
    _step(cp, "annie", ANALYZE_OK)
    d = _step(cp, "echo", ALIGN_DOWN)
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "synthia" and d["state_id"] == "tailoring"
    assert "[UNALIGNED]" in d["task_summary"]


def test_nice_up_tailors_with_canonical_verbiage(cp):
    _start(cp)
    _step(cp, "annie", ANALYZE_OK)
    d = _step(cp, "echo", ALIGN_OK)
    assert d["agent"] == "synthia" and d["state_id"] == "tailoring"
    assert "[UNALIGNED]" not in d["task_summary"]
    assert "canonical NICE TKS verbiage" in d["task_summary"]
    assert "NEVER fabricate" in d["task_summary"]


# ---------------------------------------------------------------------------
# happy path: tailor -> validate -> export -> complete
# ---------------------------------------------------------------------------


def test_happy_path_completes_with_output_path(cp):
    _to_validating(cp)
    d = _step(cp, "vera", VERA_PASS)
    assert d["agent"] == "skribble" and d["state_id"] == "exporting"
    assert "/tmp/resumes" in d["task_summary"]
    assert "word_generate" in d["task_summary"]
    d2 = _step(cp, "skribble", EXPORT_OK)
    assert d2["action"] == "complete"
    assert d2["result"]["met"] is True
    rs = d2["result"]["rez_summary"]
    assert rs["output_path"] == EXPORT_OK["output_path"]
    assert rs["company"] == "ExampleCorp" and rs["role"] == "Senior AppSec Engineer"
    assert rs["nice_aligned"] is True and rs["nice_version"] == "2.2.0 (2026-04-28)"
    assert rs["match_count"] == 9 and rs["miss_count"] == 2
    assert rs["accomplishments_used"] is True
    assert d2["result"]["session_room"] == f"skills/rez-{SID}"
    assert d2["result"]["mempalace_drawers"] == {"wing": "penny", "room": f"skills/rez-{SID}"}
    assert d2["result"]["exhausted"] is False and d2["result"]["unresolved_issues"] == []


def test_unaligned_run_reports_skip_in_result(cp):
    _to_validating(cp, align=ALIGN_DOWN)
    _step(cp, "vera", VERA_PASS)
    d = _step(cp, "skribble", EXPORT_OK)
    assert d["action"] == "complete"
    assert d["result"]["rez_summary"]["nice_aligned"] is False


# ---------------------------------------------------------------------------
# revision loop + honest exhaustion (no export of an unverified resume)
# ---------------------------------------------------------------------------


def test_validation_failure_dispatches_revision(cp):
    _to_validating(cp)
    d = _step(cp, "vera", _vera_fail(["bullet 3 metric '80%' not in sources"]))
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "synthia" and d["state_id"] == "tailoring"
    assert "Mode: REVISION" in d["task_summary"]
    assert "bullet 3 metric '80%' not in sources" in d["task_summary"]


def test_fabrication_blocks_export_even_when_otherwise_valid(cp):
    _to_validating(cp)
    d = _step(cp, "vera", {**VERA_PASS, "fabrication_free": False, "issues": ["invented CVE"]})
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "synthia" and d["state_id"] == "tailoring"  # revise, never export


def test_exhaustion_completes_honestly_without_export(cp):
    _to_validating(cp, constraints={"max_iterations": 2})
    d = _step(cp, "vera", _vera_fail(["issue a"]))  # iter 0 -> revise
    assert d["state_id"] == "tailoring"
    _step(cp, "synthia", TAILOR_OK)
    d2 = _step(cp, "vera", _vera_fail(["issue b"]))  # iter 1 -> budget spent
    assert d2["action"] == "complete"
    assert d2["result"]["met"] is False
    assert d2["result"]["exhausted"] is True
    assert d2["result"]["unresolved_issues"] == ["issue b"]
    assert d2["result"]["rez_summary"]["output_path"] == ""  # nothing exported


def test_stalled_revisions_escalate(cp):
    # Same issue every round -> the stall detector (window 2) escalates on the
    # third failure — BEFORE the exhaustion branch would burn the budget.
    _to_validating(cp)  # default budget 3
    _step(cp, "vera", _vera_fail(["same problem"]))  # iter 0 -> revise
    _step(cp, "synthia", TAILOR_OK)
    _step(cp, "vera", _vera_fail(["same problem"]))  # iter 1 -> revise
    _step(cp, "synthia", TAILOR_OK)
    d = _step(cp, "vera", _vera_fail(["same problem"]))  # iter 2 -> stall
    assert d["action"] == "escalate_to_user"
    assert "no measurable progress" in d["unknown_reason"]


# ---------------------------------------------------------------------------
# export failure — error, no fallback
# ---------------------------------------------------------------------------


def test_export_failure_errors_with_no_fallback(cp):
    _to_validating(cp)
    _step(cp, "vera", VERA_PASS)
    d = _step(
        cp,
        "skribble",
        {
            "export_ok": False,
            "word_extension_available": False,
            "error": "word_generate tool unavailable",
        },
    )
    assert d["action"] == "error"
    assert EXPORT_ERROR.split(" ")[0] in str(d)  # "ERROR:"
    assert "word_generate tool unavailable" in str(d)


def test_export_ok_without_path_is_failure(cp):
    _to_validating(cp)
    _step(cp, "vera", VERA_PASS)
    d = _step(cp, "skribble", {"export_ok": True})
    assert d["action"] == "error"


# ---------------------------------------------------------------------------
# escalation + clarify resume (re-enters at analyzing)
# ---------------------------------------------------------------------------


def test_needs_clarification_escalates_with_questions(cp):
    _start(cp)
    d = _step(
        cp,
        "annie",
        {
            **ANALYZE_OK,
            "needs_clarification": True,
            "clarifying_questions": ["Two postings on the page — which role?"],
        },
    )
    assert d["action"] == "escalate_to_user"
    assert "which role?" in d["unknown_reason"]
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER
    assert rec.current_state_id == "awaiting_clarification"


def test_clarify_resumes_at_analyzing(cp):
    _start(cp)
    _step(cp, "annie", {**ANALYZE_OK, "needs_clarification": True})
    d = _step(cp, "user", {"answer": "the senior role"})
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "annie" and d["state_id"] == "analyzing"
    assert "User clarification: the senior role" in d["task_summary"]


def test_vera_uncertain_escalates(cp):
    _to_validating(cp)
    d = _step(
        cp,
        "vera",
        {
            "valid": False,
            "fabrication_free": False,
            "issues": [],
            "evidence": ["ambiguous source attribution"],
            "confidence": "UNCERTAIN",
        },
    )
    assert d["action"] == "escalate_to_user"
    assert d["previous_state"] == "validating"


def test_validate_rejects_empty_evidence(cp):
    _to_validating(cp)
    d = _step(cp, "vera", {"valid": True, "fabrication_free": True, "issues": [], "evidence": []})
    assert d["action"] == "invoke_agent" and d["state_id"] == "validating"
    d2 = _step(cp, "vera", VERA_PASS)
    assert d2["state_id"] == "exporting"


def test_validate_evidence_lands_on_context(cp):
    _to_validating(cp)
    _step(cp, "vera", VERA_PASS)
    assert cp.load(RID).context.verify_evidence


def test_recall_lessons_render_in_first_directive(cp):
    pb = RezPlaybook(cp)
    ctx = RunContext(session_id=SID, run_id=RID, playbook="rez", goal="tailor for JD")
    ctx.recall_lessons = ["quantify every bullet; never fabricate a metric"]
    txt = pb._task_summary("analyzing", REZ_ANALYZE, ctx)
    assert "Lessons from prior runs" in txt
    assert "quantify every bullet" in txt


# ---------------------------------------------------------------------------
# SUMMARY contract enforcement
# ---------------------------------------------------------------------------


def test_malformed_analyze_summary_is_retried(cp):
    _start(cp)
    d = _step(cp, "annie", {"complete": True})  # missing jd_loaded/base_resume_found
    assert d["action"] == "invoke_agent" and d["state_id"] == "analyzing"


def test_validate_requires_fabrication_free_field(cp):
    # fabrication_free can never be silently defaulted — omitting it is a
    # contract violation, not a pass.
    _to_validating(cp)
    d = _step(cp, "vera", {"valid": True, "issues": []})
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

    monkeypatch.setitem(playbooks.PLAYBOOKS, "rez", RezPlaybook)
    _start(cp)
    _step(cp, "annie", {**ANALYZE_OK, "needs_clarification": True, "clarifying_questions": ["q?"]})
    directives = recover_pending(cp, session_id=SID, playbook="rez")
    assert len(directives) == 1 and directives[0]["action"] == "escalate_to_user"
    assert directives[0]["previous_state"] == "analyzing"
