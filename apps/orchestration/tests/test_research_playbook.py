"""Integration tests for the migrated research skill (ResearchPlaybook) on the engine.

Exercises the three modes (quick/standard/deep keyword detection + constraint
override), the single-echo researching state, BOTH bounded critique loops with
honest exhaustion (the legacy loops were unbounded), stall escalation,
needs-clarification / UNCERTAIN escalation with a working clarify resume (the
legacy resume was severed), the absolute report directory (legacy passed an
unexpanded tilde), and the run_id/checkpointer contract (fresh instance per step).
"""

from pathlib import Path

import pytest

from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.playbooks.research import ResearchPlaybook, detect_mode

SID, RID = "sess-research", "run-research"

STANDARD_GOAL = "compare postgres and mysql replication strategies for production deployments"
QUICK_GOAL = "what is retrieval augmented generation?"

SKRIBBLE_OK = {
    "write_complete": True,
    "files_written": ["report.md", "sources.md", "README.md"],
}


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


def _start(cp, goal=STANDARD_GOAL, constraints=None):
    return ResearchPlaybook(cp).start(
        session_id=SID, run_id=RID, goal=goal, constraints=constraints or {}
    )


def _step(cp, agent, result):
    return ResearchPlaybook(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


# ---------------------------------------------------------------------------
# start + mode detection
# ---------------------------------------------------------------------------


def test_start_requires_goal(cp):
    d = ResearchPlaybook(cp).start(session_id=SID, run_id=RID, goal="   ")
    assert d["action"] == "error"


def test_mode_keyword_detection():
    assert detect_mode(QUICK_GOAL) == "quick"
    assert detect_mode("deep research on rust async runtimes") == "deep"
    assert detect_mode(STANDARD_GOAL) == "standard"


def test_quick_mode_skips_planning(cp):
    d = _start(cp, goal=QUICK_GOAL)
    assert d["action"] == "invoke_agent" and d["agent"] == "echo"
    assert d["state_id"] == "researching"
    assert "Quick research:" in d["task_summary"]
    assert f"skills/research-{SID}" in d["task_summary"]
    assert "orchestrator_state" not in d


def test_standard_mode_starts_at_planning(cp):
    d = _start(cp)
    assert d["action"] == "invoke_agent" and d["agent"] == "piper"
    assert d["state_id"] == "planning"
    assert "Research planning: decompose" in d["task_summary"]
    assert f"skills/research-{SID}" in d["task_summary"]


def test_mode_constraint_overrides_detection(cp):
    # a standard-looking goal forced deep routes planning -> critiquing_plan
    _start(cp, constraints={"mode": "deep"})
    d = _step(cp, "piper", {"plan_steps": ["q1", "q2"], "plan_complete": True})
    assert d["agent"] == "carren" and d["state_id"] == "critiquing_plan"


# ---------------------------------------------------------------------------
# quick happy path (no planning, no critiques)
# ---------------------------------------------------------------------------


def test_quick_happy_path_to_complete(cp):
    _start(cp, goal=QUICK_GOAL)
    d = _step(cp, "echo", {"explore_complete": True, "confidence": "PROBABLE"})
    assert d["agent"] == "synthia" and d["state_id"] == "synthesizing"
    d = _step(cp, "synthia", {"synthesis_complete": True, "theme_count": 2})
    # independent verification gate (vera) runs in every mode before the report
    assert d["agent"] == "vera" and d["state_id"] == "validating"
    d = _step(cp, "vera", {"verdict": "PASS", "unsupported_claims": []})
    assert d["agent"] == "skribble" and d["state_id"] == "report_writing"
    # the output directory is a real ABSOLUTE path (legacy passed a literal '~')
    expected_dir = str(
        Path("~/projects/penny/research").expanduser() / "what-is-retrieval-augmented-generation"
    )
    assert expected_dir in d["task_summary"] and "~" not in d["task_summary"]
    d = _step(cp, "skribble", SKRIBBLE_OK)
    assert d["action"] == "complete"
    assert d["result"]["met"] is True and d["result"]["mode"] == "quick"
    assert d["result"]["report_drawer_id"] == f"{SID} Synthesis"
    assert d["result"]["room"] == f"skills/research-{SID}"
    assert d["result"]["report_files"] == SKRIBBLE_OK["files_written"]


# ---------------------------------------------------------------------------
# standard happy path (planning, single-echo research, no critiques)
# ---------------------------------------------------------------------------


def test_standard_happy_path_to_complete(cp):
    _start(cp)
    d = _step(cp, "piper", {"plan_steps": ["q1", "q2"], "plan_complete": True})
    # single echo agent researches ALL sub-queries (no parallel fan-out)
    assert d["action"] == "invoke_agent" and d["agent"] == "echo"
    assert "Research sub-query 1: q1" in d["task_summary"]
    assert "Research sub-query 2: q2" in d["task_summary"]
    assert f"{SID}-echo-1 Research Findings" in d["task_summary"]
    assert _step(cp, "echo", {"explore_complete": True})["state_id"] == "synthesizing"
    assert _step(cp, "synthia", {"synthesis_complete": True})["state_id"] == "validating"
    assert (
        _step(cp, "vera", {"verdict": "PASS", "unsupported_claims": []})["state_id"]
        == "report_writing"
    )
    d = _step(cp, "skribble", SKRIBBLE_OK)
    assert d["action"] == "complete" and d["result"]["met"] is True
    assert d["result"]["sub_queries"] == ["q1", "q2"]
    assert d["result"]["warnings"] == [] and d["result"]["unresolved_issues"] == []


def test_sub_queries_capped_at_mode_budget(cp):
    # standard mode caps at 3 — a 5-step plan dispatches only the first 3
    _start(cp)
    d = _step(cp, "piper", {"plan_steps": ["q1", "q2", "q3", "q4", "q5"], "plan_complete": True})
    assert "Research sub-query 3: q3" in d["task_summary"]
    assert "q4" not in d["task_summary"]


# ---------------------------------------------------------------------------
# deep mode: plan-critique loop (bounded; honest exhaustion; stall escalation)
# ---------------------------------------------------------------------------


def _deep_to_plan_critique(cp):
    _start(cp, constraints={"mode": "deep"})
    return _step(cp, "piper", {"plan_steps": ["q1", "q2", "q3"], "plan_complete": True})


def test_plan_critique_approve_proceeds_to_research(cp):
    _deep_to_plan_critique(cp)
    d = _step(cp, "carren", {"verdict": "APPROVE", "issues": []})
    assert d["agent"] == "echo" and d["state_id"] == "researching"


def test_plan_critique_revision_loops_back_to_planning(cp):
    _deep_to_plan_critique(cp)
    d = _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["missing cost angle"]})
    assert d["agent"] == "piper" and d["state_id"] == "planning"
    assert "REVISION cycle 1" in d["task_summary"]
    assert "missing cost angle" in d["task_summary"]


def test_plan_critique_exhaustion_proceeds_honestly_with_warning(cp):
    # A perpetually-rejecting critique with CHANGING issues walks the budget
    # (max_iterations default 3) then proceeds to research — never spins forever
    # (the legacy loop was unbounded) and never fabricates an APPROVE.
    _deep_to_plan_critique(cp)
    _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["issue a"]})  # iter 0
    _step(cp, "piper", {"plan_steps": ["q1"], "plan_complete": True})
    _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["issue b"]})  # iter 1
    _step(cp, "piper", {"plan_steps": ["q1"], "plan_complete": True})
    d = _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["issue c"]})  # exhausted
    assert d["action"] == "invoke_agent" and d["agent"] == "echo" and d["state_id"] == "researching"
    # finish the deep run: research -> synth -> report critique -> validate -> report
    _step(cp, "echo", {"explore_complete": True})
    _step(cp, "synthia", {"synthesis_complete": True})
    _step(cp, "carren", {"verdict": "APPROVE", "issues": []})
    _step(cp, "vera", {"verdict": "PASS", "unsupported_claims": []})
    d = _step(cp, "skribble", SKRIBBLE_OK)
    assert d["action"] == "complete"
    assert d["result"]["met"] is True  # a report WAS written
    assert d["result"]["plan_critique_exhausted"] is True
    assert d["result"]["unresolved_issues"] == ["issue c"]
    assert any("plan critique budget exhausted" in w for w in d["result"]["warnings"])
    assert d["result"]["iterations"] == 2


def test_stalled_plan_critique_escalates_instead_of_spinning(cp):
    _deep_to_plan_critique(cp)
    _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["same problem"]})  # iter 0
    _step(cp, "piper", {"plan_steps": ["q1"], "plan_complete": True})
    _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["same problem"]})  # iter 1
    _step(cp, "piper", {"plan_steps": ["q1"], "plan_complete": True})
    d = _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["same problem"]})  # stall
    assert d["action"] == "escalate_to_user"
    assert "no measurable progress" in d["unknown_reason"]
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER
    assert rec.current_state_id == "awaiting_clarification"


def test_clarify_resume_resets_stale_loop_counters(cp):
    # DEFECT 1: the escalation path never closes the active critique loop, so
    # ctx.iteration is left mid-loop (2 here). After clarify re-enters planning
    # and re-runs the deep pipeline, the FRESH plan-critique loop must start at
    # iteration 0 — a single NEEDS_REVISION must REVISE (loop back to planning),
    # NOT immediately fire plan_critique_exhausted on the first visit.
    _deep_to_plan_critique(cp)
    _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["same problem"]})  # iter 0
    _step(cp, "piper", {"plan_steps": ["q1"], "plan_complete": True})
    _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["same problem"]})  # iter 1
    _step(cp, "piper", {"plan_steps": ["q1"], "plan_complete": True})
    d = _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["same problem"]})  # stall
    assert d["action"] == "escalate_to_user"

    # user clarifies -> resume re-enters planning with counters reset to zero
    d = _step(cp, "user", {"answer": "narrow to us-east"})
    assert d["action"] == "invoke_agent" and d["state_id"] == "planning"
    rec = cp.load(RID)
    assert rec.context.iteration == 0
    assert rec.context.iteration_history == []

    # fresh plan-critique loop: first NEEDS_REVISION revises, does NOT exhaust
    _step(cp, "piper", {"plan_steps": ["q1", "q2", "q3"], "plan_complete": True})
    d = _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["fresh gap"]})
    assert d["agent"] == "piper" and d["state_id"] == "planning"
    assert "REVISION cycle 1" in d["task_summary"]


# ---------------------------------------------------------------------------
# deep mode: report-critique loop (bounded; honest exhaustion)
# ---------------------------------------------------------------------------


def _deep_to_report_critique(cp):
    _deep_to_plan_critique(cp)
    _step(cp, "carren", {"verdict": "APPROVE", "issues": []})
    _step(cp, "echo", {"explore_complete": True})
    return _step(cp, "synthia", {"synthesis_complete": True})


def test_deep_synthesis_routes_to_report_critique(cp):
    d = _deep_to_report_critique(cp)
    assert d["agent"] == "carren" and d["state_id"] == "critiquing_report"


def test_report_critique_revision_loops_back_to_synthesizing(cp):
    _deep_to_report_critique(cp)
    d = _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["overclaims in theme 2"]})
    assert d["agent"] == "synthia" and d["state_id"] == "synthesizing"
    assert "REVISION cycle 1" in d["task_summary"]
    assert "overclaims in theme 2" in d["task_summary"]


def test_report_critique_empty_issues_still_revises(cp):
    # Fix vs. legacy: NEEDS_REVISION with an empty issues list dead-ended the
    # legacy FSM into error; now any non-APPROVE verdict revises (bounded).
    _deep_to_report_critique(cp)
    d = _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": []})
    assert d["agent"] == "synthia" and d["state_id"] == "synthesizing"


def test_report_critique_exhaustion_completes_honestly(cp):
    _deep_to_report_critique(cp)
    _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["r1"]})  # iter 0
    _step(cp, "synthia", {"synthesis_complete": True})
    _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["r2"]})  # iter 1
    _step(cp, "synthia", {"synthesis_complete": True})
    d = _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["r3"]})  # exhausted
    assert d["agent"] == "vera" and d["state_id"] == "validating"
    d = _step(cp, "vera", {"verdict": "PASS", "unsupported_claims": []})
    assert d["agent"] == "skribble" and d["state_id"] == "report_writing"
    d = _step(cp, "skribble", SKRIBBLE_OK)
    assert d["action"] == "complete"
    assert d["result"]["met"] is True  # a report WAS written
    assert d["result"]["report_critique_exhausted"] is True
    assert d["result"]["unresolved_issues"] == ["r3"]
    assert any("report critique budget exhausted" in w for w in d["result"]["warnings"])


def test_stalled_report_critique_escalates(cp):
    _deep_to_report_critique(cp)
    _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["thin evidence"]})
    _step(cp, "synthia", {"synthesis_complete": True})
    _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["thin evidence"]})
    _step(cp, "synthia", {"synthesis_complete": True})
    d = _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["thin evidence"]})
    assert d["action"] == "escalate_to_user"
    assert "no measurable progress" in d["unknown_reason"]


# ---------------------------------------------------------------------------
# validation gate (vera): independent citation-grounding pass — runs in ALL
# modes as the final gate before report_writing; a FAIL loops back to
# synthesizing (bounded), honest exhaustion still ships, stall escalates.
# ---------------------------------------------------------------------------


def _standard_to_validating(cp):
    _start(cp)
    _step(cp, "piper", {"plan_steps": ["q1", "q2"], "plan_complete": True})
    _step(cp, "echo", {"explore_complete": True})
    return _step(cp, "synthia", {"synthesis_complete": True})


def test_synthesis_routes_to_validation_gate(cp):
    d = _standard_to_validating(cp)
    assert d["agent"] == "vera" and d["state_id"] == "validating"


def test_validation_pass_proceeds_to_report(cp):
    _standard_to_validating(cp)
    d = _step(cp, "vera", {"verdict": "PASS", "unsupported_claims": []})
    assert d["agent"] == "skribble" and d["state_id"] == "report_writing"


def test_validation_failure_loops_back_to_synthesizing(cp):
    _standard_to_validating(cp)
    d = _step(cp, "vera", {"verdict": "FAIL", "unsupported_claims": ["claim 3 has no source"]})
    assert d["agent"] == "synthia" and d["state_id"] == "synthesizing"
    assert "VALIDATION revision" in d["task_summary"]
    assert "claim 3 has no source" in d["task_summary"]
    # re-synthesis routes straight back to vera (not through critique in standard)
    d = _step(cp, "synthia", {"synthesis_complete": True})
    assert d["agent"] == "vera" and d["state_id"] == "validating"
    d = _step(cp, "vera", {"verdict": "PASS", "unsupported_claims": []})
    assert d["state_id"] == "report_writing"


def test_validation_exhaustion_completes_honestly(cp):
    # A verifier that keeps failing with CHANGING claims walks the budget then
    # ships the report with the unverified claims surfaced — never spins, never
    # silently marks unverified claims as verified.
    _standard_to_validating(cp)
    _step(cp, "vera", {"verdict": "FAIL", "unsupported_claims": ["c1"]})  # iter 0
    _step(cp, "synthia", {"synthesis_complete": True})
    _step(cp, "vera", {"verdict": "FAIL", "unsupported_claims": ["c2"]})  # iter 1
    _step(cp, "synthia", {"synthesis_complete": True})
    d = _step(cp, "vera", {"verdict": "FAIL", "unsupported_claims": ["c3"]})  # exhausted
    assert d["agent"] == "skribble" and d["state_id"] == "report_writing"
    d = _step(cp, "skribble", SKRIBBLE_OK)
    assert d["action"] == "complete"
    assert d["result"]["met"] is True  # a report WAS written
    assert d["result"]["validation_exhausted"] is True
    assert d["result"]["unresolved_issues"] == ["c3"]
    assert any("validation budget exhausted" in w for w in d["result"]["warnings"])


def test_stalled_validation_escalates(cp):
    _standard_to_validating(cp)
    _step(cp, "vera", {"verdict": "FAIL", "unsupported_claims": ["same claim"]})
    _step(cp, "synthia", {"synthesis_complete": True})
    _step(cp, "vera", {"verdict": "FAIL", "unsupported_claims": ["same claim"]})
    _step(cp, "synthia", {"synthesis_complete": True})
    d = _step(cp, "vera", {"verdict": "FAIL", "unsupported_claims": ["same claim"]})
    assert d["action"] == "escalate_to_user"
    assert "no measurable progress" in d["unknown_reason"]


def test_deep_reaches_validation_after_report_critique_approve(cp):
    _deep_to_report_critique(cp)
    d = _step(cp, "carren", {"verdict": "APPROVE", "issues": []})
    assert d["agent"] == "vera" and d["state_id"] == "validating"
    d = _step(cp, "vera", {"verdict": "PASS", "unsupported_claims": []})
    assert d["agent"] == "skribble" and d["state_id"] == "report_writing"


# ---------------------------------------------------------------------------
# escalation (needs_clarification / UNCERTAIN / incomplete stage) + resume
# ---------------------------------------------------------------------------


def _standard_to_researching(cp):
    _start(cp)
    _step(cp, "piper", {"plan_steps": ["q1", "q2"], "plan_complete": True})


def test_needs_clarification_escalates(cp):
    _standard_to_researching(cp)
    d = _step(
        cp,
        "echo",
        {
            "explore_complete": True,
            "needs_clarification": True,
            "clarifying_questions": ["which cloud region?"],
        },
    )
    assert d["action"] == "escalate_to_user"
    assert "which cloud region?" in d["unknown_reason"]


def test_clarify_resumes_at_planning_with_clarification(cp):
    _standard_to_researching(cp)
    _step(cp, "echo", {"explore_complete": True, "needs_clarification": True})
    d = _step(cp, "user", {"answer": "us-east deployments only"})
    assert d["action"] == "invoke_agent" and d["agent"] == "piper"
    assert d["state_id"] == "planning"
    assert "User clarification: us-east deployments only" in d["task_summary"]


def test_uncertain_confidence_escalates(cp):
    _standard_to_researching(cp)
    _step(cp, "echo", {"explore_complete": True})
    d = _step(cp, "synthia", {"synthesis_complete": True, "confidence": "UNCERTAIN"})
    assert d["action"] == "escalate_to_user"
    assert d["previous_state"] == "synthesizing"


def test_incomplete_synthesis_escalates_instead_of_stalling(cp):
    _standard_to_researching(cp)
    _step(cp, "echo", {"explore_complete": True})
    d = _step(cp, "synthia", {"synthesis_complete": False})
    assert d["action"] == "escalate_to_user"
    assert "synthesis_complete=false" in d["unknown_reason"]


def test_incomplete_plan_escalates(cp):
    _start(cp)
    d = _step(cp, "piper", {"plan_steps": [], "plan_complete": False})
    assert d["action"] == "escalate_to_user"
    assert "plan_complete=false" in d["unknown_reason"]


# ---------------------------------------------------------------------------
# honest failure + SUMMARY contract enforcement
# ---------------------------------------------------------------------------


def test_failed_report_write_completes_with_met_false(cp):
    # write_complete=false completes HONESTLY with met=False (the legacy FSM
    # stalled into a generic error) — never a fabricated success.
    _start(cp, goal=QUICK_GOAL)
    _step(cp, "echo", {"explore_complete": True})
    _step(cp, "synthia", {"synthesis_complete": True})
    _step(cp, "vera", {"verdict": "PASS", "unsupported_claims": []})
    d = _step(cp, "skribble", {"write_complete": False, "files_written": []})
    assert d["action"] == "complete" and d["result"]["met"] is False


def test_malformed_summary_reissues_step(cp):
    # missing required explore_complete -> bounded retry re-issues researching
    _start(cp, goal=QUICK_GOAL)
    d = _step(cp, "echo", {"findings_count": 3})
    assert d["action"] == "invoke_agent" and d["state_id"] == "researching"


def test_wrong_agent_for_state_errors(cp):
    _start(cp)
    d = _step(cp, "synthia", {"synthesis_complete": True})
    assert d["action"] == "error"


# ---------------------------------------------------------------------------
# recovery re-presents a pending clarification
# ---------------------------------------------------------------------------


def test_recovery_re_presents_pending_clarification(cp):
    from orchestration.recovery import recover_pending

    _standard_to_researching(cp)
    _step(cp, "echo", {"explore_complete": True, "needs_clarification": True})
    directives = recover_pending(cp, session_id=SID, playbook="research")
    assert len(directives) == 1 and directives[0]["action"] == "escalate_to_user"
