"""Tests for orchestration.contracts — validate_summary, Confidence, Directives."""

import pytest

from orchestration.contracts import (
    ACT,
    FRAME,
    LEARN,
    OBSERVE,
    PLAN,
    VERIFY,
    Confidence,
    Directives,
    validate_summary,
    validate_summary_contract,
)

# A valid SUMMARY per primitive (required fields only).
VALID = {
    OBSERVE: {"observe_complete": True, "confidence": "PROBABLE"},
    FRAME: {"frame_complete": True, "success_criteria": ["a"], "confidence": "CERTAIN"},
    PLAN: {"plan_steps": ["s1"], "plan_complete": True, "confidence": "POSSIBLE"},
    ACT: {"act_complete": True, "confidence": "PROBABLE"},
    VERIFY: {"verdict": "PASS", "gaps": [], "confidence": "CERTAIN"},
    LEARN: {"learn_complete": True},
}


@pytest.mark.parametrize("primitive,summary", list(VALID.items()))
def test_valid_summaries_pass(primitive, summary):
    ok, err = validate_summary(primitive, summary)
    assert ok, err
    assert err == ""


@pytest.mark.parametrize("primitive,summary", list(VALID.items()))
def test_each_missing_required_field_fails(primitive, summary):
    from orchestration.contracts import CONTRACTS

    for field in CONTRACTS[primitive]["required"]:
        broken = dict(summary)
        broken.pop(field, None)
        ok, err = validate_summary(primitive, broken)
        assert not ok
        assert field in err and "missing" in err


def test_wrong_type_required_fails():
    ok, err = validate_summary(
        FRAME, {"frame_complete": True, "success_criteria": "not-a-list", "confidence": "CERTAIN"}
    )
    assert not ok
    assert "success_criteria" in err and "list" in err


# Exhaustive wrong-type coverage: for each required field of each primitive,
# inject a value of the wrong type and assert a loud, field-named failure.
_WRONG_VALUE_BY_TYPE = {bool: "not-bool", list: "not-list", str: 123, int: "not-int"}


@pytest.mark.parametrize("primitive,summary", list(VALID.items()))
def test_each_wrong_type_required_fails(primitive, summary):
    from orchestration.contracts import CONTRACTS

    for field, typ in CONTRACTS[primitive]["required"].items():
        broken = dict(summary)
        broken[field] = _WRONG_VALUE_BY_TYPE[typ]
        ok, err = validate_summary(primitive, broken)
        assert not ok, f"{primitive}.{field} wrong-type ({typ.__name__}) should fail"
        assert field in err and typ.__name__ in err


def test_bool_rejected_where_int_expected():
    # findings_count is int-typed; True must not satisfy it.
    ok, err = validate_summary(
        OBSERVE, {"observe_complete": True, "confidence": "PROBABLE", "findings_count": True}
    )
    assert not ok
    assert "findings_count" in err and "int" in err


def test_valid_optional_int_passes():
    ok, err = validate_summary(
        OBSERVE, {"observe_complete": True, "confidence": "PROBABLE", "findings_count": 3}
    )
    assert ok, err


def test_optional_wrong_type_fails():
    ok, err = validate_summary(
        VERIFY, {"verdict": "FAIL", "gaps": [], "confidence": "POSSIBLE", "evidence": "nope"}
    )
    assert not ok
    assert "evidence" in err


def test_unknown_primitive_fails():
    ok, err = validate_summary("NOPE", {"x": 1})
    assert not ok
    assert "unknown primitive" in err


def test_non_dict_summary_fails():
    ok, err = validate_summary(ACT, ["not", "a", "dict"])
    assert not ok
    assert "must be a dict" in err


def test_learn_does_not_require_confidence():
    # LEARN doesn't participate in the escalation FSM, so confidence is optional.
    ok, err = validate_summary(LEARN, {"learn_complete": True})
    assert ok, err


# -- Externally-grounded evidence (Rec 4) -----------------------------------


def test_evidence_field_must_be_nonempty():
    # A VERIFY-shaped contract that requires captured evidence: a bare PASS with
    # an empty evidence list fails loud (cannot ground the verdict).
    contract = {
        "required": {"verdict": str, "gaps": list, "evidence": list},
        "optional": {},
        "evidence": ("evidence",),
    }
    ok, err = validate_summary_contract(
        "V", contract, {"verdict": "PASS", "gaps": [], "evidence": []}
    )
    assert not ok and "evidence field 'evidence'" in err


def test_evidence_field_present_and_nonempty_passes():
    contract = {
        "required": {"verdict": str, "gaps": list, "evidence": list},
        "optional": {},
        "evidence": ("evidence",),
    }
    ok, err = validate_summary_contract(
        "V",
        contract,
        {"verdict": "PASS", "gaps": [], "evidence": ["$ pytest -> 12 passed"]},
    )
    assert ok, err


def test_no_evidence_key_is_backward_compatible():
    # A contract without an "evidence" key behaves exactly as before.
    contract = {"required": {"verdict": str}, "optional": {}}
    ok, err = validate_summary_contract("V", contract, {"verdict": "PASS"})
    assert ok, err


# -- Confidence -------------------------------------------------------------


def test_confidence_taxonomy():
    assert Confidence.ALL == {"CERTAIN", "PROBABLE", "POSSIBLE", "UNCERTAIN"}
    assert Confidence.is_valid("CERTAIN")
    assert not Confidence.is_valid("certain")
    assert not Confidence.is_valid(None)
    assert Confidence.is_uncertain("UNCERTAIN")
    assert not Confidence.is_uncertain("PROBABLE")


# -- Directives -------------------------------------------------------------


def test_invoke_agent_directive_shape():
    d = Directives.invoke_agent(
        agent="annie",
        task_summary="frame it",
        state_id="framing",
        session_id="s1",
        run_id="r1",
    )
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "annie"
    assert d["state_id"] == "framing"
    assert d["logical_step"] is True
    assert d["session_id"] == "s1" and d["run_id"] == "r1"
    assert "orchestrator_state" not in d  # state lives in the checkpointer


def test_invoke_agent_no_skill_context_key():
    # skillContext is owned by the TS driver, not the Python engine.
    d = Directives.invoke_agent(
        agent="annie",
        task_summary="x",
        state_id="framing",
        session_id="s",
        run_id="r",
        logical_step=False,
    )
    assert d["logical_step"] is False
    assert "skillContext" not in d


def test_all_directives_carry_session_and_run_id():
    builders = [
        Directives.invoke_agent(
            agent="a", task_summary="t", state_id="s", session_id="S", run_id="R"
        ),
        Directives.invoke_agents_parallel(
            tasks=[{"agent": "a", "task_summary": "t"}], state_id="s", session_id="S", run_id="R"
        ),
        Directives.escalate_to_user(
            questions=[], previous_state="framing", unknown_reason="why", session_id="S", run_id="R"
        ),
        Directives.complete(result={"ok": True}, session_id="S", run_id="R"),
        Directives.error(errors=["boom"], session_id="S", run_id="R"),
        Directives.status(state="framing", complete=False, session_id="S", run_id="R"),
    ]
    for d in builders:
        assert d["session_id"] == "S"
        assert d["run_id"] == "R"
        assert "orchestrator_state" not in d
        assert "state" not in d or d["action"] == "status"
