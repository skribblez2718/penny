"""Integration tests for the migrated research skill (ResearchPlaybook) on the engine.

Exercises the three modes (caller-constraint or model-declared — the keyword
detector was deleted), the DYNAMIC research fan (one echo branch per sub-query,
arrangement 4) with the single-agent quick fast-path, evidence-gated critique +
validation, BOTH bounded critique loops with honest exhaustion, stall escalation,
needs-clarification / UNCERTAIN escalation with a working clarify resume, the
absolute report directory, and the run_id/checkpointer contract.
"""

from pathlib import Path

import pytest

from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.context import RunContext
from orchestration.playbooks.research import RESEARCH_PLAN, ResearchPlaybook

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


def _plan(steps, **extra):
    return {"plan_steps": list(steps), "plan_complete": True, **extra}


def _fan_batch(n, **branch_summary):
    """A __parallel__ fan-in batch of n echo branches (sq1..sqN)."""
    base = {"explore_complete": True}
    base.update(branch_summary)
    return [
        {"branch_id": f"sq{i}", "agent": "echo", "exitCode": 0, "summary": dict(base)}
        for i in range(1, n + 1)
    ]


def _research_fan(cp, n, **branch_summary):
    """Research n sub-queries via the dynamic echo fan (standard/deep modes)."""
    return _step(cp, "__parallel__", _fan_batch(n, **branch_summary))


def _critique(verdict, issues):
    return {"verdict": verdict, "issues": issues, "evidence": ["reviewed the artifact"]}


def _validate(verdict, claims):
    return {"verdict": verdict, "unsupported_claims": claims, "evidence": ["claim-source checks"]}


# ---------------------------------------------------------------------------
# start + mode (caller-constraint or model-declared; no keyword detection)
# ---------------------------------------------------------------------------


def test_start_requires_goal(cp):
    d = ResearchPlaybook(cp).start(session_id=SID, run_id=RID, goal="   ")
    assert d["action"] == "error"


def test_explicit_quick_constraint_skips_planning(cp):
    d = _start(cp, goal=QUICK_GOAL, constraints={"mode": "quick"})
    assert d["action"] == "invoke_agent" and d["agent"] == "echo"
    assert d["state_id"] == "researching"
    assert "Quick research:" in d["task_summary"]
    assert f"skills/research-{SID}" in d["task_summary"]


def test_default_start_is_planning_for_model_to_declare_mode(cp):
    # No caller mode: the run ALWAYS transits planning; piper declares the mode.
    d = _start(cp, goal=QUICK_GOAL)
    assert d["action"] == "invoke_agent" and d["agent"] == "piper"
    assert d["state_id"] == "planning"


def test_model_declared_deep_routes_to_plan_critique(cp):
    _start(cp)  # no caller mode
    d = _step(cp, "piper", _plan(["q1", "q2"], mode="deep"))
    assert d["agent"] == "carren" and d["state_id"] == "critiquing_plan"


def test_model_declared_standard_fans_out_research(cp):
    _start(cp)
    d = _step(cp, "piper", _plan(["q1", "q2"], mode="standard"))
    assert d["action"] == "invoke_agents_parallel" and d["state_id"] == "researching"
    assert {t["branch_id"] for t in d["tasks"]} == {"sq1", "sq2"}
    assert all(t["agent"] == "echo" for t in d["tasks"])


def test_unknown_declared_mode_falls_back_to_standard(cp):
    _start(cp)
    d = _step(cp, "piper", _plan(["q1"], mode="banana"))
    # standard -> fans out research (not the deep critique path)
    assert d["action"] == "invoke_agents_parallel" and d["state_id"] == "researching"
    assert cp.load(RID).context.extras["research"]["mode"] == "standard"


def test_caller_mode_constraint_wins(cp):
    _start(cp, constraints={"mode": "deep"})
    d = _step(cp, "piper", _plan(["q1", "q2"], mode="quick"))  # model tries to differ
    assert d["agent"] == "carren" and d["state_id"] == "critiquing_plan"


# ---------------------------------------------------------------------------
# quick happy path (explicit constraint; single-agent fast path; no critiques)
# ---------------------------------------------------------------------------


def test_quick_happy_path_to_complete(cp):
    _start(cp, goal=QUICK_GOAL, constraints={"mode": "quick"})
    d = _step(cp, "echo", {"explore_complete": True, "confidence": "PROBABLE"})
    assert d["agent"] == "synthia" and d["state_id"] == "synthesizing"
    d = _step(cp, "synthia", {"synthesis_complete": True, "theme_count": 2})
    assert d["agent"] == "vera" and d["state_id"] == "validating"
    d = _step(cp, "vera", _validate("PASS", []))
    assert d["agent"] == "skribble" and d["state_id"] == "report_writing"
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
# standard happy path (planning, research FAN, no critiques)
# ---------------------------------------------------------------------------


def test_standard_happy_path_to_complete(cp):
    _start(cp)
    d = _step(cp, "piper", _plan(["q1", "q2"]))
    assert d["action"] == "invoke_agents_parallel" and d["state_id"] == "researching"
    # each branch researches its OWN sub-query, writing a branch-tagged drawer
    joined = " ".join(t["task_summary"] for t in d["tasks"])
    assert "Sub-query: q1" in joined and "Sub-query: q2" in joined
    assert f"{SID}-echo-1 Research Findings" in joined
    assert _research_fan(cp, 2)["state_id"] == "synthesizing"
    assert _step(cp, "synthia", {"synthesis_complete": True})["state_id"] == "validating"
    assert _step(cp, "vera", _validate("PASS", []))["state_id"] == "report_writing"
    d = _step(cp, "skribble", SKRIBBLE_OK)
    assert d["action"] == "complete" and d["result"]["met"] is True
    assert d["result"]["sub_queries"] == ["q1", "q2"]
    assert d["result"]["warnings"] == [] and d["result"]["unresolved_issues"] == []


def test_sub_queries_capped_at_budget(cp):
    # default budget is 4 — a 6-step plan dispatches only the first 4 branches,
    # with a visible truncation warning (no magic per-mode table).
    _start(cp)
    d = _step(cp, "piper", _plan(["q1", "q2", "q3", "q4", "q5", "q6"]))
    assert {t["branch_id"] for t in d["tasks"]} == {"sq1", "sq2", "sq3", "sq4"}
    assert cp.load(RID).context.extras["research"]["sub_queries"] == ["q1", "q2", "q3", "q4"]


def test_max_sub_queries_constraint_is_the_budget(cp):
    _start(cp, constraints={"max_sub_queries": 2})
    d = _step(cp, "piper", _plan(["q1", "q2", "q3", "q4"]))
    assert {t["branch_id"] for t in d["tasks"]} == {"sq1", "sq2"}


# ---------------------------------------------------------------------------
# deep mode: plan-critique loop (bounded; honest exhaustion; stall escalation)
# ---------------------------------------------------------------------------


def _deep_to_plan_critique(cp):
    _start(cp, constraints={"mode": "deep"})
    return _step(cp, "piper", _plan(["q1", "q2", "q3"]))


def test_plan_critique_approve_proceeds_to_research(cp):
    _deep_to_plan_critique(cp)
    d = _step(cp, "carren", _critique("APPROVE", []))
    assert d["action"] == "invoke_agents_parallel" and d["state_id"] == "researching"


def test_plan_critique_revision_loops_back_to_planning(cp):
    _deep_to_plan_critique(cp)
    d = _step(cp, "carren", _critique("NEEDS_REVISION", ["missing cost angle"]))
    assert d["agent"] == "piper" and d["state_id"] == "planning"
    assert "REVISION cycle 1" in d["task_summary"]
    assert "missing cost angle" in d["task_summary"]


def test_plan_critique_exhaustion_proceeds_honestly_with_warning(cp):
    _deep_to_plan_critique(cp)
    _step(cp, "carren", _critique("NEEDS_REVISION", ["issue a"]))  # iter 0
    _step(cp, "piper", _plan(["q1"]))
    _step(cp, "carren", _critique("NEEDS_REVISION", ["issue b"]))  # iter 1
    _step(cp, "piper", _plan(["q1"]))
    d = _step(cp, "carren", _critique("NEEDS_REVISION", ["issue c"]))  # exhausted
    assert d["action"] == "invoke_agents_parallel" and d["state_id"] == "researching"
    _research_fan(cp, 1)
    _step(cp, "synthia", {"synthesis_complete": True})
    _step(cp, "carren", _critique("APPROVE", []))
    _step(cp, "vera", _validate("PASS", []))
    d = _step(cp, "skribble", SKRIBBLE_OK)
    assert d["action"] == "complete"
    assert d["result"]["met"] is True
    assert d["result"]["plan_critique_exhausted"] is True
    assert d["result"]["unresolved_issues"] == ["issue c"]
    assert any("plan critique budget exhausted" in w for w in d["result"]["warnings"])


def test_stalled_plan_critique_escalates_instead_of_spinning(cp):
    _deep_to_plan_critique(cp)
    _step(cp, "carren", _critique("NEEDS_REVISION", ["same problem"]))  # iter 0
    _step(cp, "piper", _plan(["q1"]))
    _step(cp, "carren", _critique("NEEDS_REVISION", ["same problem"]))  # iter 1
    _step(cp, "piper", _plan(["q1"]))
    d = _step(cp, "carren", _critique("NEEDS_REVISION", ["same problem"]))  # stall
    assert d["action"] == "escalate_to_user"
    assert "no measurable progress" in d["unknown_reason"]
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER
    assert rec.current_state_id == "awaiting_clarification"


def test_clarify_resume_resets_stale_loop_counters(cp):
    _deep_to_plan_critique(cp)
    _step(cp, "carren", _critique("NEEDS_REVISION", ["same problem"]))
    _step(cp, "piper", _plan(["q1"]))
    _step(cp, "carren", _critique("NEEDS_REVISION", ["same problem"]))
    _step(cp, "piper", _plan(["q1"]))
    d = _step(cp, "carren", _critique("NEEDS_REVISION", ["same problem"]))  # stall
    assert d["action"] == "escalate_to_user"

    d = _step(cp, "user", {"answer": "narrow to us-east"})
    assert d["action"] == "invoke_agent" and d["state_id"] == "planning"
    rec = cp.load(RID)
    assert rec.context.iteration == 0
    assert rec.context.iteration_history == []

    _step(cp, "piper", _plan(["q1", "q2", "q3"]))
    d = _step(cp, "carren", _critique("NEEDS_REVISION", ["fresh gap"]))
    assert d["agent"] == "piper" and d["state_id"] == "planning"
    assert "REVISION cycle 1" in d["task_summary"]


# ---------------------------------------------------------------------------
# deep mode: report-critique loop (bounded; honest exhaustion)
# ---------------------------------------------------------------------------


def _deep_to_report_critique(cp):
    _deep_to_plan_critique(cp)
    _step(cp, "carren", _critique("APPROVE", []))
    _research_fan(cp, 3)
    return _step(cp, "synthia", {"synthesis_complete": True})


def test_deep_synthesis_routes_to_report_critique(cp):
    d = _deep_to_report_critique(cp)
    assert d["agent"] == "carren" and d["state_id"] == "critiquing_report"


def test_report_critique_revision_loops_back_to_synthesizing(cp):
    _deep_to_report_critique(cp)
    d = _step(cp, "carren", _critique("NEEDS_REVISION", ["overclaims in theme 2"]))
    assert d["agent"] == "synthia" and d["state_id"] == "synthesizing"
    assert "REVISION cycle 1" in d["task_summary"]
    assert "overclaims in theme 2" in d["task_summary"]


def test_report_critique_empty_issues_still_revises(cp):
    _deep_to_report_critique(cp)
    d = _step(cp, "carren", _critique("NEEDS_REVISION", []))
    assert d["agent"] == "synthia" and d["state_id"] == "synthesizing"


def test_report_critique_exhaustion_completes_honestly(cp):
    _deep_to_report_critique(cp)
    _step(cp, "carren", _critique("NEEDS_REVISION", ["r1"]))
    _step(cp, "synthia", {"synthesis_complete": True})
    _step(cp, "carren", _critique("NEEDS_REVISION", ["r2"]))
    _step(cp, "synthia", {"synthesis_complete": True})
    d = _step(cp, "carren", _critique("NEEDS_REVISION", ["r3"]))  # exhausted
    assert d["agent"] == "vera" and d["state_id"] == "validating"
    d = _step(cp, "vera", _validate("PASS", []))
    assert d["agent"] == "skribble" and d["state_id"] == "report_writing"
    d = _step(cp, "skribble", SKRIBBLE_OK)
    assert d["action"] == "complete"
    assert d["result"]["met"] is True
    assert d["result"]["report_critique_exhausted"] is True
    assert d["result"]["unresolved_issues"] == ["r3"]
    assert any("report critique budget exhausted" in w for w in d["result"]["warnings"])


def test_stalled_report_critique_escalates(cp):
    _deep_to_report_critique(cp)
    _step(cp, "carren", _critique("NEEDS_REVISION", ["thin evidence"]))
    _step(cp, "synthia", {"synthesis_complete": True})
    _step(cp, "carren", _critique("NEEDS_REVISION", ["thin evidence"]))
    _step(cp, "synthia", {"synthesis_complete": True})
    d = _step(cp, "carren", _critique("NEEDS_REVISION", ["thin evidence"]))
    assert d["action"] == "escalate_to_user"
    assert "no measurable progress" in d["unknown_reason"]


# ---------------------------------------------------------------------------
# validation gate (vera): evidence-gated citation-grounding in ALL modes
# ---------------------------------------------------------------------------


def _standard_to_validating(cp):
    _start(cp)
    _step(cp, "piper", _plan(["q1", "q2"]))
    _research_fan(cp, 2)
    return _step(cp, "synthia", {"synthesis_complete": True})


def test_synthesis_routes_to_validation_gate(cp):
    d = _standard_to_validating(cp)
    assert d["agent"] == "vera" and d["state_id"] == "validating"


def test_validation_pass_proceeds_to_report(cp):
    _standard_to_validating(cp)
    d = _step(cp, "vera", _validate("PASS", []))
    assert d["agent"] == "skribble" and d["state_id"] == "report_writing"


def test_validation_rejects_empty_evidence(cp):
    _standard_to_validating(cp)
    # PASS with empty evidence violates the contract -> bounded retry.
    d = _step(cp, "vera", {"verdict": "PASS", "unsupported_claims": [], "evidence": []})
    assert d["action"] == "invoke_agent" and d["state_id"] == "validating"
    d2 = _step(cp, "vera", _validate("PASS", []))
    assert d2["state_id"] == "report_writing"


def test_validation_evidence_lands_on_context(cp):
    _standard_to_validating(cp)
    _step(cp, "vera", _validate("FAIL", ["claim 3 unsupported"]))
    assert cp.load(RID).context.verify_evidence


def test_validation_failure_loops_back_to_synthesizing(cp):
    _standard_to_validating(cp)
    d = _step(cp, "vera", _validate("FAIL", ["claim 3 has no source"]))
    assert d["agent"] == "synthia" and d["state_id"] == "synthesizing"
    assert "VALIDATION revision" in d["task_summary"]
    assert "claim 3 has no source" in d["task_summary"]
    d = _step(cp, "synthia", {"synthesis_complete": True})
    assert d["agent"] == "vera" and d["state_id"] == "validating"
    d = _step(cp, "vera", _validate("PASS", []))
    assert d["state_id"] == "report_writing"


def test_validation_exhaustion_completes_honestly(cp):
    _standard_to_validating(cp)
    _step(cp, "vera", _validate("FAIL", ["c1"]))
    _step(cp, "synthia", {"synthesis_complete": True})
    _step(cp, "vera", _validate("FAIL", ["c2"]))
    _step(cp, "synthia", {"synthesis_complete": True})
    d = _step(cp, "vera", _validate("FAIL", ["c3"]))  # exhausted
    assert d["agent"] == "skribble" and d["state_id"] == "report_writing"
    d = _step(cp, "skribble", SKRIBBLE_OK)
    assert d["action"] == "complete"
    assert d["result"]["met"] is True
    assert d["result"]["validation_exhausted"] is True
    assert d["result"]["unresolved_issues"] == ["c3"]
    assert any("validation budget exhausted" in w for w in d["result"]["warnings"])


def test_stalled_validation_escalates(cp):
    _standard_to_validating(cp)
    _step(cp, "vera", _validate("FAIL", ["same claim"]))
    _step(cp, "synthia", {"synthesis_complete": True})
    _step(cp, "vera", _validate("FAIL", ["same claim"]))
    _step(cp, "synthia", {"synthesis_complete": True})
    d = _step(cp, "vera", _validate("FAIL", ["same claim"]))
    assert d["action"] == "escalate_to_user"
    assert "no measurable progress" in d["unknown_reason"]


def test_deep_reaches_validation_after_report_critique_approve(cp):
    _deep_to_report_critique(cp)
    d = _step(cp, "carren", _critique("APPROVE", []))
    assert d["agent"] == "vera" and d["state_id"] == "validating"
    d = _step(cp, "vera", _validate("PASS", []))
    assert d["agent"] == "skribble" and d["state_id"] == "report_writing"


# ---------------------------------------------------------------------------
# escalation (needs_clarification / UNCERTAIN / incomplete stage) + resume
# ---------------------------------------------------------------------------


def _standard_to_researching(cp):
    _start(cp)
    _step(cp, "piper", _plan(["q1", "q2"]))


def test_research_branch_clarification_escalates(cp):
    # A branch that needs clarification and honestly reports UNCERTAIN drives the
    # engine's weakest-confidence escalation (fan-in aggregation).
    _standard_to_researching(cp)
    batch = _fan_batch(2)
    batch[0]["summary"] = {
        "explore_complete": False,
        "needs_clarification": True,
        "clarifying_questions": ["which cloud region?"],
        "confidence": "UNCERTAIN",
    }
    d = _step(cp, "__parallel__", batch)
    assert d["action"] == "escalate_to_user"
    assert d["previous_state"] == "researching"


def test_clarify_resumes_at_planning_with_clarification(cp):
    _standard_to_researching(cp)
    batch = _fan_batch(2)
    batch[0]["summary"] = {"explore_complete": False, "confidence": "UNCERTAIN"}
    _step(cp, "__parallel__", batch)
    d = _step(cp, "user", {"answer": "us-east deployments only"})
    assert d["action"] == "invoke_agent" and d["agent"] == "piper"
    assert d["state_id"] == "planning"
    assert "User clarification: us-east deployments only" in d["task_summary"]


def test_uncertain_confidence_escalates(cp):
    _standard_to_researching(cp)
    _research_fan(cp, 2)
    d = _step(cp, "synthia", {"synthesis_complete": True, "confidence": "UNCERTAIN"})
    assert d["action"] == "escalate_to_user"
    assert d["previous_state"] == "synthesizing"


def test_incomplete_synthesis_escalates_instead_of_stalling(cp):
    _standard_to_researching(cp)
    _research_fan(cp, 2)
    d = _step(cp, "synthia", {"synthesis_complete": False})
    assert d["action"] == "escalate_to_user"
    assert "synthesis_complete=false" in d["unknown_reason"]


def test_incomplete_plan_escalates(cp):
    _start(cp)
    d = _step(cp, "piper", {"plan_steps": [], "plan_complete": False})
    assert d["action"] == "escalate_to_user"
    assert "plan_complete=false" in d["unknown_reason"]


# ---------------------------------------------------------------------------
# honest failure + SUMMARY contract + recall
# ---------------------------------------------------------------------------


def test_failed_report_write_completes_with_met_false(cp):
    _start(cp, goal=QUICK_GOAL, constraints={"mode": "quick"})
    _step(cp, "echo", {"explore_complete": True})
    _step(cp, "synthia", {"synthesis_complete": True})
    _step(cp, "vera", _validate("PASS", []))
    d = _step(cp, "skribble", {"write_complete": False, "files_written": []})
    assert d["action"] == "complete" and d["result"]["met"] is False


def test_malformed_summary_reissues_step(cp):
    _start(cp, goal=QUICK_GOAL, constraints={"mode": "quick"})
    d = _step(cp, "echo", {"findings_count": 3})
    assert d["action"] == "invoke_agent" and d["state_id"] == "researching"


def test_wrong_agent_for_state_errors(cp):
    _start(cp)
    d = _step(cp, "synthia", {"synthesis_complete": True})
    assert d["action"] == "error"


def test_recall_lessons_render_in_first_directive(cp):
    pb = ResearchPlaybook(cp)
    ctx = RunContext(session_id=SID, run_id=RID, playbook="research", goal=STANDARD_GOAL)
    ctx.recall_lessons = ["prefer primary sources; cite them"]
    txt = pb._task_summary("planning", RESEARCH_PLAN, ctx)
    assert "Lessons from prior runs" in txt
    assert "prefer primary sources" in txt


# ---------------------------------------------------------------------------
# recovery re-presents a pending clarification
# ---------------------------------------------------------------------------


def test_recovery_re_presents_pending_clarification(cp):
    from orchestration.recovery import recover_pending

    _standard_to_researching(cp)
    batch = _fan_batch(2)
    batch[0]["summary"] = {"explore_complete": False, "confidence": "UNCERTAIN"}
    _step(cp, "__parallel__", batch)
    directives = recover_pending(cp, session_id=SID, playbook="research")
    assert len(directives) == 1 and directives[0]["action"] == "escalate_to_user"
