"""Tests for orchestration.context.RunContext (serialization round-trip)."""

import pytest

from orchestration.context import RunContext


def _full_context() -> RunContext:
    return RunContext(
        session_id="sess-1",
        run_id="run-1",
        playbook="reference-cycle",
        project_root="/proj",
        goal="do the thing",
        constraints={"criteria_ref": "drawer:abc", "max_iterations": 3},
        success_criteria=["c1", "c2"],
        plan_steps=[{"step": "one", "done_when": "x"}],
        verify_verdict="FAIL",
        verify_gaps=["missing test"],
        iteration=1,
        max_iterations=3,
        stakes="high",
        last_confidence="PROBABLE",
        clarification_text="user said go",
        previous_state="framing",
        unknown_reason="ambiguous scope",
        last_seq=7,
        step_retries=1,
        total_steps=9,
        met=False,
        complete=False,
        errors=["one warning"],
    )


def test_round_trip_identity():
    ctx = _full_context()
    d = ctx.to_dict()
    ctx2 = RunContext.from_dict(d)
    assert ctx2 == ctx
    assert ctx2.to_dict() == d


def test_to_dict_has_all_keys():
    d = _full_context().to_dict()
    for k in (
        "session_id",
        "run_id",
        "playbook",
        "project_root",
        "goal",
        "constraints",
        "extras",
        "success_criteria",
        "plan_steps",
        "verify_verdict",
        "verify_gaps",
        "iteration",
        "max_iterations",
        "stakes",
        "last_confidence",
        "clarification_text",
        "previous_state",
        "unknown_reason",
        "last_seq",
        "step_retries",
        "total_steps",
        "iteration_history",
        "met",
        "complete",
        "errors",
    ):
        assert k in d


def test_from_dict_defaults_for_missing_optional_keys():
    ctx = RunContext.from_dict({"session_id": "s", "run_id": "r", "playbook": "p"})
    assert ctx.goal == ""
    assert ctx.constraints == {}
    assert ctx.max_iterations == 3
    assert ctx.iteration == 0
    assert ctx.errors == []


def test_from_dict_rejects_unknown_keys():
    # Unknown top-level keys fail loud (checkpoint schema drift) rather than
    # being silently dropped; playbook-specific data belongs in extras.
    with pytest.raises(ValueError, match="unknown keys"):
        RunContext.from_dict(
            {"session_id": "s", "run_id": "r", "playbook": "p", "bogus": 123, "extra": "x"}
        )


def test_extras_round_trip():
    ctx = RunContext.from_dict(
        {
            "session_id": "s",
            "run_id": "r",
            "playbook": "p",
            "extras": {"code": {"language": "python", "iteration": 2}},
        }
    )
    assert ctx.extras == {"code": {"language": "python", "iteration": 2}}
    assert ctx.to_dict()["extras"]["code"]["iteration"] == 2


def test_from_dict_missing_required_raises():
    with pytest.raises(ValueError):
        RunContext.from_dict({"run_id": "r", "playbook": "p"})  # no session_id


def test_from_dict_non_dict_raises():
    with pytest.raises(TypeError):
        RunContext.from_dict(["not", "a", "dict"])


def test_mutable_defaults_are_independent():
    a = RunContext(session_id="s", run_id="r", playbook="p")
    b = RunContext(session_id="s", run_id="r2", playbook="p")
    a.errors.append("x")
    a.success_criteria.append("c")
    assert b.errors == []
    assert b.success_criteria == []
