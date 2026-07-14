"""Integration tests for the migrated agent skill (AgentPlaybook) on the engine.

Each step() constructs a FRESH playbook instance pointed at the same checkpointer
(subprocess-per-invocation reality). Exercises the explore → design → critique →
scaffold → verify flow, the bounded critique revision loop (legacy 'revising'
state never fired its transitions), the bounded verify → re-scaffold loop (legacy
was UNBOUNDED), honest exhaustion (met=False, never a fabricated APPROVE/pass),
stall escalation, needs-clarification / UNCERTAIN escalation, the
skribble-sourced agent_name fix (legacy used goal.split()[0]), and the
evidence-grounded vera VERIFY.
"""

import pytest

from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.playbooks.agent import AgentPlaybook

SID, RID = "sess-agent", "run-agent"

_EXPLORE_OK = {"explore_complete": True, "findings_count": 3, "files_count": 5}
_DESIGN_OK = {
    "design_steps": [{"field": "name", "value": "climate-researcher"}],
    "design_complete": True,
}
_APPROVE = {"verdict": "APPROVE", "issues": [], "evidence": ["all standard checks pass"]}
_SCAFFOLD_OK = {
    "generation_complete": True,
    "files_created": [".pi/agents/climate-researcher.md"],
    "files_modified": [],
    "agent_definition": "---\nname: climate-researcher",
    "agent_file_path": ".pi/agents/climate-researcher.md",
}
_VERIFY_PASS = {
    "yaml_valid": True,
    "schema_valid": True,
    "diff_applied": True,
    "verification_complete": True,
    "evidence": ["frontmatter: name/description/tools/model present", "all sections in order"],
}


def _verify_fail(*failed):
    s = dict(_VERIFY_PASS)
    s["verification_complete"] = False
    s["evidence"] = ["validation report: FAIL on " + ", ".join(failed)]
    for k in failed:
        s[k] = False
    return s


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


def _start(cp, goal="Build climate research agent", constraints=None):
    return AgentPlaybook(cp).start(
        session_id=SID, run_id=RID, goal=goal, constraints=constraints or {}
    )


def test_recall_lessons_render_in_first_directive(cp):
    from orchestration.context import RunContext
    from orchestration.primitives.spec import PrimitiveSpec

    pb = AgentPlaybook(cp)
    ctx = RunContext(session_id=SID, run_id=RID, playbook="agent", goal="build an agent")
    ctx.recall_lessons = ["description is the routing surface; keep use/don't-use signals sharp"]
    spec = PrimitiveSpec("X", "echo", {"required": {}, "optional": {}}, "explore")
    txt = pb._task_summary("_no_builder_state_", spec, ctx)
    assert "Lessons from prior runs" in txt
    assert "routing surface" in txt


def _step(cp, agent, result):
    return AgentPlaybook(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


def _to_critiquing(cp, constraints=None):
    _start(cp, constraints=constraints)
    _step(cp, "echo", _EXPLORE_OK)
    _step(cp, "piper", _DESIGN_OK)


def _to_verifying(cp):
    _to_critiquing(cp)
    _step(cp, "carren", _APPROVE)
    _step(cp, "skribble", _SCAFFOLD_OK)


def _redesign_to_critiquing(cp):
    """After a critique_retry_explore: echo → piper → back to critiquing."""
    _step(cp, "echo", _EXPLORE_OK)
    _step(cp, "piper", _DESIGN_OK)


# ---------------------------------------------------------------------------
# start
# ---------------------------------------------------------------------------


def test_start_requires_goal(cp):
    d = AgentPlaybook(cp).start(session_id=SID, run_id=RID, goal="  ")
    assert d["action"] == "error"


def test_start_emits_single_echo_explore(cp):
    d = _start(cp)
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "echo" and d["state_id"] == "exploring"
    assert d["run_id"] == RID and "orchestrator_state" not in d
    # mempalace room + legacy drawer header preserved verbatim
    assert f"skills/agent-{SID}" in d["task_summary"]
    assert f"{SID} Explore" in d["task_summary"]


def test_constraint_agent_name_hint_flows_into_tasks(cp):
    d = _start(cp, constraints={"agent_name": "climate-researcher"})
    assert "Agent name: climate-researcher." in d["task_summary"]


# ---------------------------------------------------------------------------
# Full happy path
# ---------------------------------------------------------------------------


def test_full_happy_path_to_complete(cp):
    _start(cp)
    assert _step(cp, "echo", _EXPLORE_OK)["state_id"] == "designing"
    d = _step(cp, "piper", _DESIGN_OK)
    assert d["agent"] == "carren" and d["state_id"] == "critiquing"
    assert f"{SID} Critique" in d["task_summary"]
    d = _step(cp, "carren", _APPROVE)
    assert d["agent"] == "skribble" and d["state_id"] == "scaffolding"
    d = _step(cp, "skribble", _SCAFFOLD_OK)
    assert d["agent"] == "vera" and d["state_id"] == "verifying"
    # vera reads the file skribble actually wrote and must attach evidence
    assert ".pi/agents/climate-researcher.md" in d["task_summary"]
    assert "evidence" in d["task_summary"]
    d = _step(cp, "vera", _VERIFY_PASS)
    assert d["action"] == "complete"
    assert d["result"]["met"] is True
    assert d["result"]["agent_name"] == "climate-researcher"
    assert d["result"]["agent_file_path"] == ".pi/agents/climate-researcher.md"
    assert d["result"]["verification_result"] == {
        "yaml_valid": True,
        "schema_valid": True,
        "diff_applied": True,
    }
    assert d["result"]["exhausted"] is False and d["result"]["unresolved_issues"] == []


def test_agent_name_comes_from_skribble_not_goal_first_word(cp):
    # Legacy bug: agent_name = goal.split()[0] -> 'Build'. The playbook derives
    # the name from skribble's SUMMARY (files_created when agent_file_path absent).
    _to_critiquing(cp)
    _step(cp, "carren", _APPROVE)
    scaffold = dict(_SCAFFOLD_OK)
    del scaffold["agent_file_path"]  # force the files_created fallback
    d = _step(cp, "skribble", scaffold)
    assert ".pi/agents/climate-researcher.md" in d["task_summary"]
    d = _step(cp, "vera", _VERIFY_PASS)
    assert d["result"]["agent_name"] == "climate-researcher"
    assert d["result"]["agent_name"] != "Build"
    assert d["result"]["agent_file_path"] == ".pi/agents/climate-researcher.md"


# ---------------------------------------------------------------------------
# Critique revision loop (legacy 'revising' state never fired its transitions)
# ---------------------------------------------------------------------------


def test_critique_rejection_first_retries_explore(cp):
    _to_critiquing(cp)
    d = _step(
        cp,
        "carren",
        {
            "verdict": "NEEDS_REVISION",
            "issues": ["missing agent_boundary"],
            "evidence": ["cited in design spec"],
        },
    )
    assert d["action"] == "invoke_agent" and d["agent"] == "echo" and d["state_id"] == "exploring"
    assert "missing agent_boundary" in d["task_summary"]


def test_second_critique_rejection_retries_design(cp):
    _to_critiquing(cp)
    _step(
        cp,
        "carren",
        {"verdict": "NEEDS_REVISION", "issues": ["issue a"], "evidence": ["cited in design spec"]},
    )  # iter 0 -> explore
    _redesign_to_critiquing(cp)
    d = _step(
        cp,
        "carren",
        {"verdict": "NEEDS_REVISION", "issues": ["issue b"], "evidence": ["cited in design spec"]},
    )  # iter 1
    assert d["action"] == "invoke_agent" and d["agent"] == "piper" and d["state_id"] == "designing"
    assert "issue b" in d["task_summary"]


def test_critique_exhaustion_completes_honestly_not_forced_approve(cp):
    # A perpetually-rejecting critique with CHANGING issues walks the budget and
    # completes with met=False + unresolved issues — never a fabricated APPROVE.
    _to_critiquing(cp)
    _step(
        cp,
        "carren",
        {"verdict": "NEEDS_REVISION", "issues": ["issue a"], "evidence": ["cited in design spec"]},
    )  # iter 0
    _redesign_to_critiquing(cp)
    _step(
        cp,
        "carren",
        {"verdict": "NEEDS_REVISION", "issues": ["issue b"], "evidence": ["cited in design spec"]},
    )  # iter 1
    _step(cp, "piper", _DESIGN_OK)
    # iter 2 -> budget spent (max_iterations default 3) -> honest completion
    d = _step(
        cp,
        "carren",
        {"verdict": "NEEDS_REVISION", "issues": ["issue c"], "evidence": ["cited in design spec"]},
    )
    assert d["action"] == "complete"
    assert d["result"]["met"] is False
    assert d["result"]["exhausted"] is True
    assert d["result"]["unresolved_issues"] == ["issue c"]
    # no file was ever scaffolded, and the verification result says so honestly
    assert d["result"]["agent_file_path"] == ""
    assert d["result"]["verification_result"] == {
        "yaml_valid": False,
        "schema_valid": False,
        "diff_applied": False,
    }


def test_critique_without_evidence_is_contract_violation(cp):
    # Externally-grounded critique: a verdict with no cited observations is a
    # contract violation and re-issues the critique step (mirrors VERIFY).
    _to_critiquing(cp)
    d = _step(cp, "carren", {"verdict": "NEEDS_REVISION", "issues": ["x"], "evidence": []})
    assert d["action"] == "invoke_agent" and d["state_id"] == "critiquing"


def test_stalled_critique_escalates_instead_of_spinning(cp):
    # Same issue every round -> stall detector escalates rather than force-approve.
    _to_critiquing(cp)
    _step(
        cp,
        "carren",
        {
            "verdict": "NEEDS_REVISION",
            "issues": ["same problem"],
            "evidence": ["cited in design spec"],
        },
    )  # iter 0
    _redesign_to_critiquing(cp)
    _step(
        cp,
        "carren",
        {
            "verdict": "NEEDS_REVISION",
            "issues": ["same problem"],
            "evidence": ["cited in design spec"],
        },
    )  # iter 1
    _step(cp, "piper", _DESIGN_OK)
    d = _step(
        cp,
        "carren",
        {
            "verdict": "NEEDS_REVISION",
            "issues": ["same problem"],
            "evidence": ["cited in design spec"],
        },
    )  # stall
    assert d["action"] == "escalate_to_user"
    assert "no measurable progress" in d["unknown_reason"]


# ---------------------------------------------------------------------------
# Verify -> re-scaffold loop (legacy was UNBOUNDED)
# ---------------------------------------------------------------------------


def test_verify_fail_loops_back_to_scaffolding_with_failed_checks(cp):
    _to_verifying(cp)
    d = _step(cp, "vera", _verify_fail("schema_valid"))
    assert d["action"] == "invoke_agent" and d["agent"] == "skribble"
    assert d["state_id"] == "scaffolding"
    assert "Fix verification failures" in d["task_summary"]
    assert "schema_valid" in d["task_summary"]


def test_verify_exhaustion_completes_honestly(cp):
    # CHANGING failure modes walk the whole budget, then complete met=False —
    # the legacy unbounded verify<->scaffold ping-pong is gone.
    _to_verifying(cp)
    _step(cp, "vera", _verify_fail("schema_valid"))  # verify iter 0 -> re-scaffold
    _step(cp, "skribble", _SCAFFOLD_OK)
    _step(cp, "vera", _verify_fail("yaml_valid"))  # verify iter 1 -> re-scaffold
    _step(cp, "skribble", _SCAFFOLD_OK)
    d = _step(cp, "vera", _verify_fail("diff_applied"))  # iter 2 -> budget spent
    assert d["action"] == "complete"
    assert d["result"]["met"] is False
    assert d["result"]["exhausted"] is True
    assert d["result"]["unresolved_issues"] == ["diff_applied"]
    assert d["result"]["verification_result"]["diff_applied"] is False


def test_stalled_verify_escalates_instead_of_spinning(cp):
    # The SAME check failing every re-scaffold -> escalate, don't burn budget.
    _to_verifying(cp)
    _step(cp, "vera", _verify_fail("schema_valid"))
    _step(cp, "skribble", _SCAFFOLD_OK)
    _step(cp, "vera", _verify_fail("schema_valid"))
    _step(cp, "skribble", _SCAFFOLD_OK)
    d = _step(cp, "vera", _verify_fail("schema_valid"))
    assert d["action"] == "escalate_to_user"
    assert "no measurable progress" in d["unknown_reason"]


def test_verify_without_evidence_is_contract_violation(cp):
    # Externally-grounded VERIFY (Rec 4): a pass with no captured validation
    # output is a contract violation and re-issues the verify step.
    _to_verifying(cp)
    summary = dict(_VERIFY_PASS)
    summary["evidence"] = []
    d = _step(cp, "vera", summary)
    assert d["action"] == "invoke_agent" and d["state_id"] == "verifying"


# ---------------------------------------------------------------------------
# Escalation (needs_clarification + UNCERTAIN) + resume
# ---------------------------------------------------------------------------


def test_designer_needs_clarification_escalates(cp):
    _start(cp)
    _step(cp, "echo", _EXPLORE_OK)
    d = _step(
        cp,
        "piper",
        {
            "design_steps": [],
            "design_complete": False,
            "needs_clarification": True,
            "clarifying_questions": ["which model should the agent use?"],
        },
    )
    assert d["action"] == "escalate_to_user"
    assert "which model should the agent use?" in d["unknown_reason"]
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER
    assert rec.current_state_id == "awaiting_clarification"


def test_uncertain_confidence_escalates(cp):
    _start(cp)
    d = _step(cp, "echo", {"explore_complete": False, "confidence": "UNCERTAIN"})
    assert d["action"] == "escalate_to_user"
    assert d["previous_state"] == "exploring"


def test_clarify_resumes_at_exploring(cp):
    _start(cp)
    _step(cp, "echo", _EXPLORE_OK)
    _step(
        cp,
        "piper",
        {"design_steps": [], "design_complete": False, "needs_clarification": True},
    )
    d = _step(cp, "user", {"answer": "use the default model"})
    assert d["action"] == "invoke_agent" and d["agent"] == "echo"
    assert d["state_id"] == "exploring"
    assert "use the default model" in d["task_summary"]


# ---------------------------------------------------------------------------
# Recovery re-presents a pending escalation
# ---------------------------------------------------------------------------


def test_recovery_re_presents_pending_escalation(cp):
    from orchestration.playbooks import PLAYBOOKS
    from orchestration.recovery import recover_pending

    PLAYBOOKS.setdefault(AgentPlaybook.NAME, AgentPlaybook)  # no-op once registered
    _start(cp)
    _step(cp, "echo", {"explore_complete": False, "confidence": "UNCERTAIN"})
    directives = recover_pending(cp, session_id=SID, playbook="agent")
    assert len(directives) == 1 and directives[0]["action"] == "escalate_to_user"
    assert directives[0]["previous_state"] == "exploring"
