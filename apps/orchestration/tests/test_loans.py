"""Tests for the LOAN registry + Ablate hooks (atomic-loop-components invariant
6 / LOAN lifecycle): registry hygiene (every loan tagged with rationale, dates,
and a working toggle), fail-loud unknown ids, and each wired mechanism verified
scaffold-ON vs scaffold-OFF.
"""

import pytest

from orchestration.context import RunContext
from orchestration.engine import BasePlaybook
from orchestration.loans import LOANS, list_loans, loan_enabled
from orchestration.outcome_writer import _failure_mode
from orchestration.primitives.spec import PrimitiveSpec

# ---------------------------------------------------------------------------
# Registry hygiene — the compliance guard for invariant 6
# ---------------------------------------------------------------------------


def test_registry_is_non_empty():
    assert len(LOANS) >= 4  # the engine's known loans are tagged


def test_every_loan_has_rationale_dates_and_toggle():
    for loan in list_loans():
        assert loan.loan_id and loan.loan_id == loan.loan_id.lower()
        assert loan.description.strip()
        assert loan.rationale.strip(), f"{loan.loan_id}: a loan must name the weakness it covers"
        assert loan.added.strip(), f"{loan.loan_id}: missing added date"
        assert loan.review_by.strip(), f"{loan.loan_id}: missing expiry review date"
        assert loan.toggle_env == f"PENNY_ABLATE_{loan.loan_id.upper()}"


def test_unknown_loan_id_fails_loud():
    with pytest.raises(KeyError):
        loan_enabled("not_a_registered_loan")


def test_toggle_disables_and_default_enables(monkeypatch):
    for loan in list_loans():
        monkeypatch.delenv(loan.toggle_env, raising=False)
        assert loan_enabled(loan.loan_id) is True
        monkeypatch.setenv(loan.toggle_env, "1")
        assert loan_enabled(loan.loan_id) is False
        monkeypatch.delenv(loan.toggle_env, raising=False)


# ---------------------------------------------------------------------------
# Wiring: summary_schema_restatement
# ---------------------------------------------------------------------------

SPEC = PrimitiveSpec(
    "X", "skribble", {"required": {"done": bool, "confidence": str}, "optional": {}}, "do x"
)


def test_schema_restatement_on_by_default(monkeypatch):
    monkeypatch.delenv("PENNY_ABLATE_SUMMARY_SCHEMA_RESTATEMENT", raising=False)
    text = BasePlaybook._summary_contract_directive(SPEC)
    assert "SUMMARY:" in text and '"done"' in text


def test_schema_restatement_ablated(monkeypatch):
    monkeypatch.setenv("PENNY_ABLATE_SUMMARY_SCHEMA_RESTATEMENT", "1")
    assert BasePlaybook._summary_contract_directive(SPEC) == ""


# ---------------------------------------------------------------------------
# #28: tier-gate the SUMMARY-restatement crutch behind a capability flag
# ---------------------------------------------------------------------------


def test_summary_restatement_kept_for_default_tier(monkeypatch):
    monkeypatch.delenv("PENNY_ABLATE_SUMMARY_SCHEMA_RESTATEMENT", raising=False)
    monkeypatch.delenv("PI_MODEL_TIER", raising=False)
    assert "SUMMARY:" in BasePlaybook._summary_contract_directive(SPEC)


def test_summary_restatement_skipped_for_strong_tier(monkeypatch):
    monkeypatch.delenv("PENNY_ABLATE_SUMMARY_SCHEMA_RESTATEMENT", raising=False)
    monkeypatch.setenv("PI_MODEL_TIER", "strong")
    assert BasePlaybook._summary_contract_directive(SPEC) == ""


def test_summary_restatement_kept_for_cheap_tier(monkeypatch):
    monkeypatch.delenv("PENNY_ABLATE_SUMMARY_SCHEMA_RESTATEMENT", raising=False)
    monkeypatch.setenv("PI_MODEL_TIER", "cheap")
    assert "SUMMARY:" in BasePlaybook._summary_contract_directive(SPEC)


# ---------------------------------------------------------------------------
# #33: HITL gate-answer intent classifier (keyword fast-path + gated model)
# ---------------------------------------------------------------------------


def _mstream(text):
    import json as _j

    msg = {
        "type": "message_end",
        "message": {
            "role": "assistant", "stopReason": "stop",
            "content": [{"type": "text", "text": text}],
        },
    }
    return _j.dumps({"type": "agent_start"}) + "\n" + _j.dumps(msg)


def _mrunner(stdout):
    import types as _t

    def run(cmd, **kwargs):
        return _t.SimpleNamespace(stdout=stdout, stderr="", returncode=0)

    return run


def test_gate_intent_keyword_fast_path(monkeypatch):
    monkeypatch.delenv("PI_GATE_INTENT_MODEL", raising=False)
    ci = BasePlaybook.classify_gate_intent
    assert ci("approve") == "approve"
    assert ci("CONFIRM") == "approve"
    assert ci("deny") == "deny"
    assert ci("stop") == "deny"
    assert ci("") == "refine"
    # free text with the gate OFF -> safe default refine (never a silent approve/deny)
    assert ci("yep, ship it") == "refine"


def test_gate_intent_model_reads_free_text_when_gated(monkeypatch):
    import json as _j

    monkeypatch.setenv("PI_GATE_INTENT_MODEL", "anthropic/haiku")
    approve = _j.dumps({"answer": "approve", "evidence": ["ship it"], "confidence": "CERTAIN"})
    assert BasePlaybook.classify_gate_intent(
        "yep, ship it", runner=_mrunner(_mstream(approve))
    ) == "approve"
    deny = _j.dumps({"answer": "deny", "confidence": "PROBABLE"})
    assert BasePlaybook.classify_gate_intent(
        "nah, kill it", runner=_mrunner(_mstream(deny))
    ) == "deny"


def test_gate_intent_low_confidence_approve_is_safe_refine(monkeypatch):
    import json as _j

    monkeypatch.setenv("PI_GATE_INTENT_MODEL", "anthropic/haiku")
    weak = _j.dumps({"answer": "approve", "confidence": "POSSIBLE"})
    # an UNCERTAIN approval must NOT proceed the seam -> refine (re-ask)
    assert BasePlaybook.classify_gate_intent(
        "maybe? i guess", runner=_mrunner(_mstream(weak))
    ) == "refine"


def test_gate_intent_model_failure_is_safe_refine(monkeypatch):
    monkeypatch.setenv("PI_GATE_INTENT_MODEL", "anthropic/haiku")

    def boom(cmd, **kwargs):
        raise OSError("spawn failed")

    assert BasePlaybook.classify_gate_intent("some free text", runner=boom) == "refine"


# ---------------------------------------------------------------------------
# Wiring: task_digest_cap
# ---------------------------------------------------------------------------


def test_cap_truncates_by_default(monkeypatch):
    monkeypatch.delenv("PENNY_ABLATE_TASK_DIGEST_CAP", raising=False)
    out = BasePlaybook._cap("x" * 700)
    assert len(out) < 700 and out.endswith("…[truncated]")


def test_cap_ablated_passes_through(monkeypatch):
    monkeypatch.setenv("PENNY_ABLATE_TASK_DIGEST_CAP", "1")
    assert BasePlaybook._cap("x" * 700) == "x" * 700


# ---------------------------------------------------------------------------
# Wiring: failure_mode_keywords
# ---------------------------------------------------------------------------


def _mismatch_ctx(gaps):
    ctx = RunContext(session_id="s", run_id="r", playbook="code")
    ctx.verify_gaps = gaps
    return ctx


def test_failure_mode_keywords_on_by_default(monkeypatch):
    monkeypatch.delenv("PENNY_ABLATE_FAILURE_MODE_KEYWORDS", raising=False)
    assert _failure_mode(_mismatch_ctx(["missing constraint on auth"]), "MISMATCH") == (
        "missing_constraint"
    )


def test_failure_mode_keywords_ablated_falls_back(monkeypatch):
    monkeypatch.setenv("PENNY_ABLATE_FAILURE_MODE_KEYWORDS", "1")
    assert _failure_mode(_mismatch_ctx(["missing constraint on auth"]), "MISMATCH") == "incomplete"


# ---------------------------------------------------------------------------
# Wiring: malformed_summary_retry (engine-level, via a tiny playbook)
# ---------------------------------------------------------------------------

from statemachine import State, StateMachine  # noqa: E402

from orchestration.checkpointer import Checkpointer  # noqa: E402


class TinyMachine(StateMachine):
    intake = State(initial=True)
    working = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    start = intake.to(working)
    work_done = working.to(complete)
    to_unknown = working.to(unknown)
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(working)
    abort = working.to(error) | unknown.to(error) | awaiting_clarification.to(error)


TINY_C = {"required": {"done": bool, "confidence": str}, "optional": {}}


class TinyPlaybook(BasePlaybook):
    NAME = "tiny"
    machine_cls = TinyMachine
    PRIMITIVE_BY_STATE = {"working": PrimitiveSpec("WORK", "skribble", TINY_C, "work")}
    ESCALATABLE_STATES = frozenset({"working"})

    def initial_transition(self, ctx):
        self.sm.send("start")
        return "working"

    def route_after(self, state, ctx, summary):
        self.sm.send("work_done")


def test_malformed_summary_retries_by_default(tmp_path, monkeypatch):
    monkeypatch.delenv("PENNY_ABLATE_MALFORMED_SUMMARY_RETRY", raising=False)
    cp = Checkpointer(db_path=tmp_path / "orch.db")
    TinyPlaybook(cp).start(session_id="s", run_id="r", goal="g")
    d = TinyPlaybook(cp).step(session_id="s", run_id="r", agent="skribble", result={"bogus": 1})
    assert d["action"] == "invoke_agent"  # bounded re-issue (loan ON)


def test_malformed_summary_fails_immediately_when_ablated(tmp_path, monkeypatch):
    monkeypatch.setenv("PENNY_ABLATE_MALFORMED_SUMMARY_RETRY", "1")
    cp = Checkpointer(db_path=tmp_path / "orch.db")
    TinyPlaybook(cp).start(session_id="s", run_id="r", goal="g")
    d = TinyPlaybook(cp).step(session_id="s", run_id="r", agent="skribble", result={"bogus": 1})
    assert d["action"] == "error"
    assert "format-repair retry ablated" in d["errors"][0]


def test_transport_failure_still_retries_when_loan_ablated(tmp_path, monkeypatch):
    """exitCode retries are plumbing, not the loan — unaffected by the toggle."""
    monkeypatch.setenv("PENNY_ABLATE_MALFORMED_SUMMARY_RETRY", "1")
    cp = Checkpointer(db_path=tmp_path / "orch.db")
    TinyPlaybook(cp).start(session_id="s", run_id="r", goal="g")
    wrapped = {"exitCode": 1, "summary": None, "summary_missing": False, "error": "boom"}
    d = TinyPlaybook(cp).step(session_id="s", run_id="r", agent="skribble", result=wrapped)
    assert d["action"] == "invoke_agent"  # re-issued despite the ablated loan
