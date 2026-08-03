"""Integration tests for the migrated research skill (ResearchPlaybook) on the engine.

Exercises the three modes (caller-constraint or model-declared — the keyword
detector was deleted), the DYNAMIC research fan (one echo branch per sub-query,
arrangement 4) with the single-agent quick fast-path, evidence-gated critique +
validation, BOTH bounded critique loops with honest exhaustion, stall escalation,
needs-clarification / UNCERTAIN escalation with a working clarify resume, the
absolute report directory, and the run_id/checkpointer contract.
"""

import re
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


_TEST_ROOT = "/tmp/penny-test"


def _start(cp, goal=STANDARD_GOAL, constraints=None, project_root=_TEST_ROOT):
    return ResearchPlaybook(cp).start(
        session_id=SID, run_id=RID, goal=goal, constraints=constraints or {}, project_root=project_root
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


def _validate(verdict, claims, needed=None):
    out = {"verdict": verdict, "unsupported_claims": claims, "evidence": ["claim-source checks"]}
    if needed is not None:
        out["evidence_needed"] = needed
    return out


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
        Path(_TEST_ROOT) / "research" / "what-is-retrieval-augmented-generation"
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


def test_blank_sub_queries_are_dropped_at_capture(cp):
    """Only NON-BLANK sub-queries are usable. ``_research_branches`` already
    skipped blanks, so an unfiltered list left the fan and the task builder
    disagreeing about what counts as a sub-query."""
    _start(cp)
    d = _step(cp, "piper", _plan(["q1", "   ", "", "q2"]))
    assert {t["branch_id"] for t in d["tasks"]} == {"sq1", "sq2"}
    assert cp.load(RID).context.extras["research"]["sub_queries"] == ["q1", "q2"]


def test_whitespace_only_plan_falls_back_to_single_agent_not_blank_subqueries(cp):
    """The degenerate path that made the legacy multi-sub-query branch reachable:
    a plan of whitespace-only steps yielded NO fan branches but a truthy
    sub_queries list, so a single agent was handed a task enumerating blank
    sub-queries. It must now collapse cleanly to the single-agent task."""
    _start(cp)
    d = _step(cp, "piper", _plan(["  ", ""]))
    assert d["action"] == "invoke_agent" and d["agent"] == "echo"
    assert d["state_id"] == "researching"
    assert "Quick research:" in d["task_summary"]
    assert "Research ALL" not in d["task_summary"]
    assert "sub-query 1" not in d["task_summary"]


def test_planning_task_states_the_real_budget(cp):
    """The planning task must quote the ACTUAL budget, not a stale fallback that
    contradicted it (the builder said 3 while the constant was 4)."""
    d = _start(cp)
    assert d["state_id"] == "planning"
    assert cp.load(RID).context.extras["research"]["max_sub_queries"] == 4
    assert "at most 4" in d["task_summary"]
    assert "at most 3" not in d["task_summary"]


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
# the validation verdict is the run's QUALITY signal on the context
# (the outcome ledger reads ctx.verify_verdict / ctx.verify_gaps)
# ---------------------------------------------------------------------------


def test_validation_pass_records_clean_grounding_signal(cp):
    _standard_to_validating(cp)
    _step(cp, "vera", _validate("PASS", []))
    ctx = cp.load(RID).context
    assert ctx.verify_verdict == "PASS"
    assert ctx.verify_gaps == []


def test_validation_failure_records_unsupported_claims_on_context(cp):
    _standard_to_validating(cp)
    _step(cp, "vera", _validate("FAIL", ["claim 3 has no citation"]))
    ctx = cp.load(RID).context
    assert ctx.verify_verdict == "FAIL"
    assert ctx.verify_gaps == ["claim 3 has no citation"]


def test_regrounded_run_ends_with_a_clean_signal(cp):
    """A FAIL that is genuinely re-grounded must not leave stale gaps behind:
    the signal reflects the FINAL verdict, not the worst one."""
    _standard_to_validating(cp)
    _step(cp, "vera", _validate("FAIL", ["claim 3 has no source"]))
    _step(cp, "synthia", {"synthesis_complete": True})
    _step(cp, "vera", _validate("PASS", []))
    d = _step(cp, "skribble", SKRIBBLE_OK)
    assert d["result"]["grounded"] is True
    ctx = cp.load(RID).context
    assert ctx.verify_verdict == "PASS" and ctx.verify_gaps == []


def test_shipped_but_unverified_run_is_distinguishable_in_the_ledger(cp):
    """A report shipped with unverified claims must be DISTINGUISHABLE from a
    fully grounded one in the outcome ledger. Before this signal existed, both
    recorded an empty verify_gaps and were identical to every ledger reader."""
    from orchestration.outcome_writer import build_outcome_content

    _standard_to_validating(cp)
    _step(cp, "vera", _validate("FAIL", ["c1 unsupported"]))
    _step(cp, "synthia", {"synthesis_complete": True})
    _step(cp, "vera", _validate("FAIL", ["c2 unsupported"]))
    _step(cp, "synthia", {"synthesis_complete": True})
    _step(cp, "vera", _validate("FAIL", ["c3 unsupported"]))  # budget exhausted
    d = _step(cp, "skribble", SKRIBBLE_OK)

    # Delivery is still honest: the report WAS written.
    assert d["action"] == "complete"
    assert d["result"]["met"] is True
    assert d["result"]["validation_exhausted"] is True
    # ...but the run no longer claims to be grounded.
    assert d["result"]["grounded"] is False
    assert d["result"]["unresolved_issues"] == ["c3 unsupported"]

    ctx = cp.load(RID).context
    assert ctx.verify_verdict == "FAIL"
    assert ctx.verify_gaps == ["c3 unsupported"]
    # The ledger record itself carries the grounding failure + its evidence.
    content = build_outcome_content(ctx)
    assert '"verify_verdict": "FAIL"' in content
    assert "c3 unsupported" in content


def test_grounded_is_false_when_validation_never_ran(cp):
    """A run that errors before the gate must not report grounded=True."""
    ctx = RunContext(session_id=SID, run_id=RID, playbook="research", goal=STANDARD_GOAL)
    assert ResearchPlaybook(cp).result_payload(ctx)["grounded"] is False


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


def test_clarify_resumes_at_the_producer_that_can_use_the_answer(cp):
    """A research-phase clarification resumes at RESEARCHING, keeping the plan.

    Previously every clarification re-entered `planning`, discarding the plan, its
    critique cycles and all completed research to answer one scoping question. The
    answer belongs to the agent that can act on it — here, the researchers.
    """
    _standard_to_researching(cp)
    plan_before = cp.load(RID).context.extras["research"]["sub_queries"]
    batch = _fan_batch(2)
    batch[0]["summary"] = {"explore_complete": False, "confidence": "UNCERTAIN"}
    _step(cp, "__parallel__", batch)

    d = _step(cp, "user", {"answer": "us-east deployments only"})
    assert d["action"] == "invoke_agents_parallel" and d["state_id"] == "researching"
    assert all(t["agent"] == "echo" for t in d["tasks"])
    # the clarification reaches every branch...
    joined = " ".join(t["task_summary"] for t in d["tasks"])
    assert joined.count("User clarification: us-east deployments only") == len(d["tasks"])
    # ...and the plan survived rather than being thrown away
    assert cp.load(RID).context.extras["research"]["sub_queries"] == plan_before


def test_clarify_from_a_stalled_plan_critique_resumes_at_the_planner(cp):
    """Re-running the critic on an unchanged plan cannot use the answer — the PLAN
    has to change, so the producer is piper."""
    _deep_to_plan_critique(cp)
    for _ in range(2):
        _step(cp, "carren", _critique("NEEDS_REVISION", ["same problem"]))
        _step(cp, "piper", _plan(["q1"]))
    d = _step(cp, "carren", _critique("NEEDS_REVISION", ["same problem"]))
    assert d["action"] == "escalate_to_user"
    d = _step(cp, "user", {"answer": "drop the cost angle"})
    assert d["agent"] == "piper" and d["state_id"] == "planning"


def test_clarify_from_the_validation_gate_resumes_at_the_synthesizer(cp):
    """A stalled citation gate needs the SYNTHESIS to change, not another vera pass."""
    _standard_to_validating(cp)
    _step(cp, "vera", _validate("FAIL", ["same claim"]))
    _step(cp, "synthia", {"synthesis_complete": True})
    _step(cp, "vera", _validate("FAIL", ["same claim"]))
    _step(cp, "synthia", {"synthesis_complete": True})
    d = _step(cp, "vera", _validate("FAIL", ["same claim"]))
    assert d["action"] == "escalate_to_user"
    d = _step(cp, "user", {"answer": "drop claim 3"})
    assert d["agent"] == "synthia" and d["state_id"] == "synthesizing"
    assert "User clarification: drop claim 3" in d["task_summary"]


def test_mid_pipeline_resume_preserves_exhaustion_history(cp):
    """Exhaustion flags are historical FACTS the result must still report. Resuming
    mid-pipeline continues the same run, so they must not be wiped (a full restart
    from planning still clears them)."""
    _start(cp, constraints={"mode": "deep"})
    _step(cp, "piper", _plan(["q1"]))
    for issue in ("a", "b", "c"):
        _step(cp, "carren", _critique("NEEDS_REVISION", [issue]))
        if issue != "c":
            _step(cp, "piper", _plan(["q1"]))
    assert cp.load(RID).context.extras["research"]["plan_critique_exhausted"] is True
    _research_fan(cp, 1)
    d = _step(cp, "synthia", {"synthesis_complete": False})  # escalates
    assert d["action"] == "escalate_to_user"
    _step(cp, "user", {"answer": "focus on managed offerings"})
    research = cp.load(RID).context.extras["research"]
    assert research["plan_critique_exhausted"] is True, "honest history was wiped on resume"


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


# ---------------------------------------------------------------------------
# report_format is a free-form instruction, not an enum
# ---------------------------------------------------------------------------


def test_arbitrary_report_format_reaches_the_synthesizer(cp):
    """The doc used to publish a 4-value enum the code never enforced. Any shaping
    instruction must reach synthia verbatim — the model reads it, code does not gate it."""
    _start(cp, constraints={"report_format": "a one-page memo for a non-technical exec"})
    _step(cp, "piper", _plan(["q1"]))
    _research_fan(cp, 1)
    d = cp.load(RID)
    assert d.context.extras["research"]["report_format"].startswith("a one-page memo")


def test_default_report_format_adds_no_shaping_instruction(cp):
    _start(cp)
    _step(cp, "piper", _plan(["q1"]))
    d = _research_fan(cp, 1)
    assert "Use default format" not in d["task_summary"]


# ---------------------------------------------------------------------------
# report directory: readable AND collision-free
# ---------------------------------------------------------------------------


def test_similar_long_queries_get_distinct_report_dirs(cp):
    """Two queries sharing a long prefix must NOT share a directory — the second run
    would silently overwrite the first run's report.md, the run's only artifact."""
    from orchestration.playbooks.research import _sanitize_topic

    base = "compare postgres and mysql replication strategies for production deployments"
    a = _sanitize_topic(f"{base} on aws")
    b = _sanitize_topic(f"{base} on gcp")
    assert a != b, "long related queries collided onto one directory"


def test_report_dir_is_deterministic_for_the_same_query(cp):
    from orchestration.playbooks.research import _sanitize_topic

    q = "what is retrieval augmented generation?"
    assert _sanitize_topic(q) == _sanitize_topic(q)


def test_report_dir_stays_readable_and_filesystem_safe(cp):
    from orchestration.playbooks.research import _sanitize_topic

    slug = _sanitize_topic("What is Retrieval-Augmented Generation?! (2026 edition)")
    assert slug.startswith("what-is-retrieval-augmented-generation")
    assert re.fullmatch(r"[a-z0-9-]+", slug), slug
    assert len(slug) <= 80


def test_pathological_query_still_yields_a_usable_dir(cp):
    """A query of pure punctuation must not produce an empty directory name."""
    from orchestration.playbooks.research import _sanitize_topic

    slug = _sanitize_topic("?!?!")
    assert slug and re.fullmatch(r"[a-z0-9-]+", slug)


# ---------------------------------------------------------------------------
# mode as a BUDGET PRESET (rigor decoupled from the label)
# ---------------------------------------------------------------------------


def _budget(cp):
    return cp.load(RID).context.extras["research"]


def test_mode_expands_to_a_rigor_budget(cp):
    _start(cp, constraints={"mode": "deep"})
    assert _budget(cp)["critique_passes"] == 2
    assert _budget(cp)["max_research_rounds"] == 3


def test_model_declared_mode_expands_the_budget_at_planning(cp):
    _start(cp)  # no caller mode
    _step(cp, "piper", _plan(["q1"], mode="deep"))
    assert _budget(cp)["critique_passes"] == 2


def test_mode_does_not_dictate_breadth(cp):
    """A per-mode sub-query count was deleted as a Bitter-Lesson violation. Mode
    governs VERIFICATION spend; breadth stays one budget the model spends within."""
    from orchestration.playbooks.research import MODE_BUDGETS

    for preset in MODE_BUDGETS.values():
        assert "max_sub_queries" not in preset
    _start(cp, constraints={"mode": "quick"})
    assert _budget(cp)["max_sub_queries"] == 4  # the single budget, not a mode value


def test_critique_passes_constraint_decouples_rigor_from_the_label(cp):
    """A standard run can buy an adversarial report read without deep's plan critique."""
    _start(cp, constraints={"mode": "standard", "critique_passes": 1})
    d = _step(cp, "piper", _plan(["q1", "q2"]))
    # 1 pass -> NO plan critique (that costs the 2nd pass)
    assert d["action"] == "invoke_agents_parallel" and d["state_id"] == "researching"
    _research_fan(cp, 2)
    d = _step(cp, "synthia", {"synthesis_complete": True})
    # ...but the report critique DOES run, on a run whose label is "standard"
    assert d["agent"] == "carren" and d["state_id"] == "critiquing_report"


def test_zero_critique_passes_on_deep_label_skips_both_critiques(cp):
    """The label is not the authority — the budget is."""
    _start(cp, constraints={"mode": "deep", "critique_passes": 0})
    d = _step(cp, "piper", _plan(["q1"]))
    assert d["state_id"] == "researching"
    _research_fan(cp, 1)
    d = _step(cp, "synthia", {"synthesis_complete": True})
    assert d["agent"] == "vera" and d["state_id"] == "validating"


def test_planning_task_tells_the_model_it_owns_the_mode_decision(cp):
    """With no caller mode the task used to render a meaningless 'Mode: .' — dropping
    the instruction that the model owns the choice."""
    d = _start(cp)
    assert "Mode: ." not in d["task_summary"]
    assert "YOU declare it" in d["task_summary"]
    d = _start(cp, constraints={"mode": "deep"})
    assert "Mode: deep." in d["task_summary"]


# ---------------------------------------------------------------------------
# rigor escalation (OPT-IN): a struggling run can EARN an adversarial read
# ---------------------------------------------------------------------------


def test_rigor_escalation_is_off_by_default(cp):
    """Default OFF: the published quick/standard validation loop is unchanged."""
    _standard_to_validating(cp)
    d = _step(cp, "vera", _validate("FAIL", ["c1"]))
    assert d["agent"] == "synthia" and d["state_id"] == "synthesizing"
    d = _step(cp, "synthia", {"synthesis_complete": True})
    assert d["agent"] == "vera" and d["state_id"] == "validating"  # straight back to the gate
    assert _budget(cp)["critique_passes"] == 0


def test_rigor_escalation_grants_one_critique_pass_when_enabled(cp):
    _start(cp, constraints={"rigor_escalation": True})
    _step(cp, "piper", _plan(["q1", "q2"]))
    _research_fan(cp, 2)
    _step(cp, "synthia", {"synthesis_complete": True})
    d = _step(cp, "vera", _validate("FAIL", ["c1"]))  # no researchable gap named
    assert d["agent"] == "synthia" and d["state_id"] == "synthesizing"
    assert _budget(cp)["critique_passes"] == 1
    assert _budget(cp)["rigor_escalated"] is True
    # the earned pass is SPENT: the next synthesis gets carren's adversarial read
    d = _step(cp, "synthia", {"synthesis_complete": True})
    assert d["agent"] == "carren" and d["state_id"] == "critiquing_report"


def test_rigor_escalation_is_once_per_run_and_terminates(cp):
    """It must not grant a pass every cycle, and the run must still reach a terminal
    state rather than ping-ponging between the gate and the critic."""
    _start(cp, constraints={"rigor_escalation": True})
    _step(cp, "piper", _plan(["q1"]))
    _research_fan(cp, 1)
    _step(cp, "synthia", {"synthesis_complete": True})
    _step(cp, "vera", _validate("FAIL", ["c1"]))  # escalates
    _step(cp, "synthia", {"synthesis_complete": True})
    _step(cp, "carren", _critique("APPROVE", []))  # critique loop closes
    d = _step(cp, "vera", _validate("PASS", []))
    assert d["agent"] == "skribble" and d["state_id"] == "report_writing"
    d = _step(cp, "skribble", SKRIBBLE_OK)
    assert d["action"] == "complete" and d["result"]["met"] is True
    assert d["result"]["rigor_escalated"] is True
    assert any("escalated rigor" in w for w in d["result"]["warnings"])


def test_rigor_escalation_prefers_evidence_seeking_when_a_gap_is_named(cp):
    """Searching for the missing evidence beats re-reading the same draft, so a named
    gap must take the research edge rather than burn the escalation."""
    _start(cp, constraints={"rigor_escalation": True})
    _step(cp, "piper", _plan(["q1"]))
    _research_fan(cp, 1)
    _step(cp, "synthia", {"synthesis_complete": True})
    d = _step(cp, "vera", _validate("FAIL", ["c1"], ["gap A"]))
    assert d["state_id"] == "researching"
    assert _budget(cp).get("rigor_escalated") is not True


# ---------------------------------------------------------------------------
# EVIDENCE-SEEKING loop: validating -> researching (the iterative research loop)
# ---------------------------------------------------------------------------


def test_named_evidence_gap_refans_research_instead_of_only_rewriting(cp):
    """The core repayment: a citation failure with a researchable gap must buy MORE
    SEARCH, not just claim-deletion. (The synthesizer has no web tools by design,
    so re-grounding alone can only ever make the report thinner.)"""
    _standard_to_validating(cp)
    d = _step(cp, "vera", _validate("FAIL", ["claim 3 unsupported"], ["primary source for the 40% figure"]))
    assert d["action"] == "invoke_agents_parallel" and d["state_id"] == "researching"
    task = d["tasks"][0]["task_summary"]
    assert "EVIDENCE-SEEKING" in task
    assert "primary source for the 40% figure" in task
    assert "no supporting source found" in task  # honest-negative escape hatch


def test_evidence_round_continues_branch_numbering_and_does_not_overwrite(cp):
    """Round two must write NEW drawers, not clobber round one's findings."""
    _start(cp)
    _step(cp, "piper", _plan(["q1", "q2", "q3"]))  # branches 1-3
    _research_fan(cp, 3)
    _step(cp, "synthia", {"synthesis_complete": True})
    d = _step(cp, "vera", _validate("FAIL", ["c1"], ["gap A", "gap B"]))
    assert {t["branch_id"] for t in d["tasks"]} == {"sq4", "sq5"}
    joined = " ".join(t["task_summary"] for t in d["tasks"])
    assert f"{SID}-echo-4 Research Findings" in joined
    assert f"{SID}-echo-5 Research Findings" in joined


def test_evidence_round_returns_through_synthesis_to_the_gate(cp):
    """validating -> researching -> synthesizing -> validating, and the synthesizer
    is told new findings landed."""
    _standard_to_validating(cp)
    _step(cp, "vera", _validate("FAIL", ["c1"], ["gap A"]))
    batch = [{"branch_id": "sq3", "agent": "echo", "exitCode": 0,
              "summary": {"explore_complete": True}}]
    d = _step(cp, "__parallel__", batch)
    assert d["agent"] == "synthia" and d["state_id"] == "synthesizing"
    assert "EVIDENCE-SEEKING research round ran" in d["task_summary"]
    assert "DROP the claim" in d["task_summary"]
    d = _step(cp, "synthia", {"synthesis_complete": True})
    assert d["agent"] == "vera" and d["state_id"] == "validating"
    d = _step(cp, "vera", _validate("PASS", []))
    assert d["state_id"] == "report_writing"
    d = _step(cp, "skribble", SKRIBBLE_OK)
    assert d["result"]["grounded"] is True and d["result"]["research_rounds"] == 2


def test_fail_without_a_named_gap_still_only_reworks_the_synthesis(cp):
    """No researchable gap named -> unchanged legacy behaviour (re-ground only)."""
    _standard_to_validating(cp)
    d = _step(cp, "vera", _validate("FAIL", ["c1"]))
    assert d["agent"] == "synthia" and d["state_id"] == "synthesizing"


def test_empty_evidence_needed_is_treated_as_no_gap(cp):
    _standard_to_validating(cp)
    d = _step(cp, "vera", _validate("FAIL", ["c1"], ["   ", ""]))
    assert d["agent"] == "synthia" and d["state_id"] == "synthesizing"


def test_research_round_budget_is_a_hard_ceiling(cp):
    """Once the round budget is spent, a named gap falls back to re-grounding — the
    loop cannot spin on search forever."""
    _standard_to_validating(cp)
    _step(cp, "vera", _validate("FAIL", ["c1"], ["gap A"]))  # round 2 (budget = 2)
    batch = [{"branch_id": "sq3", "agent": "echo", "exitCode": 0,
              "summary": {"explore_complete": True}}]
    _step(cp, "__parallel__", batch)
    _step(cp, "synthia", {"synthesis_complete": True})
    d = _step(cp, "vera", _validate("FAIL", ["c2"], ["gap B"]))  # budget spent
    assert d["agent"] == "synthia" and d["state_id"] == "synthesizing"


def test_max_research_rounds_1_disables_evidence_seeking_entirely(cp):
    """The reversibility switch: constraints={'max_research_rounds': 1} restores the
    exact pre-P6 single-round pipeline."""
    _start(cp, constraints={"max_research_rounds": 1})
    _step(cp, "piper", _plan(["q1", "q2"]))
    _research_fan(cp, 2)
    _step(cp, "synthia", {"synthesis_complete": True})
    d = _step(cp, "vera", _validate("FAIL", ["c1"], ["gap A"]))
    assert d["agent"] == "synthia" and d["state_id"] == "synthesizing"


def test_evidence_seeking_still_exhausts_honestly(cp):
    """Non-regression on the capability that must not break: the run still ships a
    report and still reports its unverified claims rather than faking a pass."""
    _standard_to_validating(cp)
    _step(cp, "vera", _validate("FAIL", ["c1"], ["gap A"]))
    batch = [{"branch_id": "sq3", "agent": "echo", "exitCode": 0,
              "summary": {"explore_complete": True}}]
    _step(cp, "__parallel__", batch)
    _step(cp, "synthia", {"synthesis_complete": True})
    d = _step(cp, "vera", _validate("FAIL", ["c2"], ["gap B"]))  # -> revise
    _step(cp, "synthia", {"synthesis_complete": True})
    d = _step(cp, "vera", _validate("FAIL", ["c3"]))  # budget exhausted
    assert d["agent"] == "skribble" and d["state_id"] == "report_writing"
    d = _step(cp, "skribble", SKRIBBLE_OK)
    assert d["action"] == "complete"
    assert d["result"]["met"] is True
    assert d["result"]["grounded"] is False
    assert d["result"]["validation_exhausted"] is True
    assert d["result"]["unresolved_issues"] == ["c3"]


def test_evidence_seeking_still_escalates_on_a_stall(cp):
    """Non-regression: repeating the SAME gap must escalate, not burn the budget."""
    _standard_to_validating(cp)
    _step(cp, "vera", _validate("FAIL", ["same claim"], ["same gap"]))
    batch = [{"branch_id": "sq3", "agent": "echo", "exitCode": 0,
              "summary": {"explore_complete": True}}]
    _step(cp, "__parallel__", batch)
    _step(cp, "synthia", {"synthesis_complete": True})
    d = _step(cp, "vera", _validate("FAIL", ["same claim"], ["same gap"]))
    _step(cp, "synthia", {"synthesis_complete": True})
    d = _step(cp, "vera", _validate("FAIL", ["same claim"]))
    assert d["action"] == "escalate_to_user"
    assert "no measurable progress" in d["unknown_reason"]


def test_evidence_gaps_are_capped_by_the_sub_query_budget(cp):
    """A verifier naming 20 gaps cannot blow past the fan budget."""
    _start(cp, constraints={"max_sub_queries": 2})
    _step(cp, "piper", _plan(["q1", "q2"]))
    _research_fan(cp, 2)
    _step(cp, "synthia", {"synthesis_complete": True})
    d = _step(cp, "vera", _validate("FAIL", ["c1"], [f"gap {i}" for i in range(20)]))
    assert len(d["tasks"]) == 2


# ---------------------------------------------------------------------------
# opt-in cross-model verification hook (model_for_state)
# ---------------------------------------------------------------------------


def _mctx(constraints=None):
    return RunContext(
        session_id=SID,
        run_id=RID,
        playbook="research",
        goal=STANDARD_GOAL,
        constraints=constraints or {},
    )


def test_unset_hook_changes_nothing(cp, monkeypatch):
    """The default path MUST be untouched: every agent keeps the model its own
    .pi/agents/*.md frontmatter declares, so the edge stays SAME_MODEL and the
    registered independence exception stays honest."""
    for var in ("RESEARCH_VERA", "RESEARCH_DEFAULT"):
        monkeypatch.delenv(var, raising=False)
    pb = ResearchPlaybook(cp)
    for state in ("planning", "researching", "synthesizing", "validating", "report_writing"):
        assert pb.model_for_state(state, _mctx()) is None, state


def test_validate_model_constraint_selects_the_verifier_model(cp, monkeypatch):
    for var in ("RESEARCH_VERA", "RESEARCH_DEFAULT"):
        monkeypatch.delenv(var, raising=False)
    pb = ResearchPlaybook(cp)
    ctx = _mctx({"validate_model": "ollama/glm"})
    assert pb.model_for_state("validating", ctx) == "ollama/glm"
    # Scoped: it must NEVER re-point the generator, or the "different model" is lost.
    assert pb.model_for_state("synthesizing", ctx) is None


def test_validate_model_constraint_beats_the_env_tier(cp, monkeypatch):
    monkeypatch.setenv("RESEARCH_VERA", "ollama/from-env")
    ctx = _mctx({"validate_model": "ollama/from-constraint"})
    assert ResearchPlaybook(cp).model_for_state("validating", ctx) == "ollama/from-constraint"


def test_env_tier_precedence_agent_then_default(cp, monkeypatch):
    monkeypatch.delenv("RESEARCH_VERA", raising=False)
    monkeypatch.setenv("RESEARCH_DEFAULT", "ollama/fallback")
    assert ResearchPlaybook(cp).model_for_state("validating", _mctx()) == "ollama/fallback"
    monkeypatch.setenv("RESEARCH_VERA", "ollama/specific")
    assert ResearchPlaybook(cp).model_for_state("validating", _mctx()) == "ollama/specific"


def test_malformed_env_override_is_ignored_not_fatal(cp, monkeypatch):
    """A typo'd override must fall through to the agent default, never break a run."""
    monkeypatch.setenv("RESEARCH_VERA", "not-a-provider-model")
    monkeypatch.delenv("RESEARCH_DEFAULT", raising=False)
    assert ResearchPlaybook(cp).model_for_state("validating", _mctx()) is None


def test_hook_reaches_the_dispatched_directive(cp, monkeypatch):
    """End-to-end: the chosen model must actually ride on the invoke_agent directive
    the driver consumes — a hook that never reaches the wire verifies nothing."""
    for var in ("RESEARCH_VERA", "RESEARCH_DEFAULT"):
        monkeypatch.delenv(var, raising=False)
    _start(cp, constraints={"validate_model": "ollama/glm"})
    _step(cp, "piper", _plan(["q1"]))
    _research_fan(cp, 1)
    d = _step(cp, "synthia", {"synthesis_complete": True})
    assert d["state_id"] == "validating" and d["agent"] == "vera"
    assert d["model"] == "ollama/glm"


def test_default_run_directive_carries_no_model_override(cp, monkeypatch):
    """With the hook unset, the validating directive must carry NO model key at all
    — the driver then uses vera's own frontmatter model (unchanged default path)."""
    for var in ("RESEARCH_VERA", "RESEARCH_DEFAULT"):
        monkeypatch.delenv(var, raising=False)
    d = _standard_to_validating(cp)  # the directive dispatching vera
    assert d["state_id"] == "validating" and d["agent"] == "vera"
    assert "model" not in d


# ---------------------------------------------------------------------------
# prompt self-sufficiency: a STRONGER model must not strip the agents' contract
# ---------------------------------------------------------------------------

_PROMPT_DIR = (
    Path(__file__).resolve().parents[3] / ".pi" / "skills" / "research" / "assets" / "prompts"
)
_RESEARCH_AGENTS = ("piper", "echo", "carren", "synthia", "vera", "skribble")


def test_engine_schema_directive_is_stripped_on_strong_tier_and_ablation(monkeypatch):
    """The engine's SUMMARY-schema restatement is a tagged LOAN: it returns ""
    under PI_MODEL_TIER=strong or when ablated. This is the intended, documented
    behaviour — pinned here because the NEXT test depends on it being true."""
    monkeypatch.delenv("PI_MODEL_TIER", raising=False)
    monkeypatch.delenv("PENNY_ABLATE_SUMMARY_SCHEMA_RESTATEMENT", raising=False)
    assert "SUMMARY:" in ResearchPlaybook._summary_contract_directive(RESEARCH_PLAN)

    monkeypatch.setenv("PI_MODEL_TIER", "strong")
    assert ResearchPlaybook._summary_contract_directive(RESEARCH_PLAN) == ""

    monkeypatch.delenv("PI_MODEL_TIER", raising=False)
    monkeypatch.setenv("PENNY_ABLATE_SUMMARY_SCHEMA_RESTATEMENT", "1")
    assert ResearchPlaybook._summary_contract_directive(RESEARCH_PLAN) == ""


def test_every_research_prompt_carries_its_own_summary_schema():
    """Because the engine directive vanishes on the strong-model path, a prompt that
    only says "per the OUTPUT FORMAT directive appended to your task" leaves its
    agent with NO typed contract exactly when a better model is declared — i.e.
    upgrading the fleet would DEGRADE the skill. Each prompt must be self-sufficient.
    (prd hit this same trap and was fixed 2026-07-28; research was not.)"""
    missing = [
        agent
        for agent in _RESEARCH_AGENTS
        if not re.search(r'SUMMARY:\{"', (_PROMPT_DIR / f"{agent}.md").read_text(encoding="utf-8"))
    ]
    assert not missing, (
        f"research prompts with no self-contained SUMMARY schema: {missing}. "
        "On PI_MODEL_TIER=strong these agents receive no output contract at all."
    )


def test_strong_tier_run_still_completes_end_to_end(cp, monkeypatch):
    """The engine path under a strong-tier declaration: directives no longer carry
    the restated schema, and the run still drives to a met+grounded completion.
    (Agent behaviour is simulated here — this pins the ENGINE contract, not the
    model's compliance.)"""
    monkeypatch.setenv("PI_MODEL_TIER", "strong")
    d = _start(cp)
    assert "OUTPUT FORMAT" not in d["task_summary"]
    _step(cp, "piper", _plan(["q1", "q2"]))
    _research_fan(cp, 2)
    _step(cp, "synthia", {"synthesis_complete": True})
    _step(cp, "vera", _validate("PASS", []))
    d = _step(cp, "skribble", SKRIBBLE_OK)
    assert d["action"] == "complete"
    assert d["result"]["met"] is True and d["result"]["grounded"] is True


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
