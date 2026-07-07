"""Tests for the generalization seams that let arbitrary domain skills ride the
engine: per-state SUMMARY contracts (custom-named specs), parallel fan-out with
weakest-confidence aggregation + resume, planned-gate HITL with multi-target
resume, the start() precondition guard, and the cycle-neutral result_payload.

Like test_engine.py, each step() constructs a FRESH playbook instance pointed at
the same checkpointer, so these inherently exercise kill-and-resume durability.
"""

import pytest
from statemachine import State, StateMachine

from orchestration import playbooks as pb_mod
from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.contracts import validate_summary_contract, weakest_confidence
from orchestration.engine import BasePlaybook
from orchestration.primitives.spec import ParallelSpec, PrimitiveSpec
from orchestration.recovery import recover_pending

SID, RID = "sess-seam", "run-seam"


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


# ---------------------------------------------------------------------------
# Per-state contract validation (custom-named specs)
# ---------------------------------------------------------------------------


def test_validate_summary_contract_accepts_custom_name():
    contract = {"required": {"triaged": bool, "confidence": str}, "optional": {"notes": str}}
    ok, err = validate_summary_contract(
        "TRIAGE", contract, {"triaged": True, "confidence": "CERTAIN"}
    )
    assert ok and err == ""


def test_validate_summary_contract_rejects_missing_and_mistyped():
    contract = {"required": {"triaged": bool}, "optional": {}}
    ok, err = validate_summary_contract("TRIAGE", contract, {})
    assert not ok and "missing required 'triaged'" in err
    ok, err = validate_summary_contract("TRIAGE", contract, {"triaged": "yes"})
    assert not ok and "must be bool" in err


def test_validate_summary_contract_tolerates_missing_optional_key():
    ok, _ = validate_summary_contract("X", {"required": {}}, {"anything": 1})
    assert ok


def test_weakest_confidence():
    assert weakest_confidence(["CERTAIN", "PROBABLE"]) == "PROBABLE"
    assert weakest_confidence(["CERTAIN", "UNCERTAIN"]) == "UNCERTAIN"
    assert weakest_confidence(["CERTAIN", "bogus"]) == "bogus"  # unknown ranks as UNCERTAIN
    assert weakest_confidence([]) == ""


# ---------------------------------------------------------------------------
# Parallel fan-out
# ---------------------------------------------------------------------------


class ParMachine(StateMachine):
    intake = State(initial=True)
    scanning = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)
    start_scan = intake.to(scanning)
    scan_done = scanning.to(complete)
    to_unknown = scanning.to(unknown)
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(scanning)
    abort = scanning.to(error) | unknown.to(error) | awaiting_clarification.to(error)


_BRANCH_C = {"required": {"passed": bool, "confidence": str}, "optional": {}}
SAST = PrimitiveSpec("SAST", "vera", _BRANCH_C, "run sast")
DEPS = PrimitiveSpec("DEPS", "echo", _BRANCH_C, "scan deps")


class ParPlaybook(BasePlaybook):
    NAME = "par-test"
    machine_cls = ParMachine
    PARALLEL_BY_STATE = {"scanning": ParallelSpec(branches={"sast": SAST, "deps": DEPS})}
    ESCALATABLE_STATES = frozenset({"scanning"})

    def initial_transition(self, ctx):
        self.sm.send("start_scan")
        return "scanning"

    def route_after(self, state, ctx, summary):
        ctx.extras["aggregated"] = summary
        self.sm.send("scan_done")


def _par_start(cp):
    return ParPlaybook(cp).start(session_id=SID, run_id=RID, goal="scan")


def _par_step(cp, entries):
    return ParPlaybook(cp).step(session_id=SID, run_id=RID, agent="__parallel__", result=entries)


def _entry(bid, agent, **summary):
    return {"branch_id": bid, "agent": agent, "exitCode": 0, "summary": summary}


def test_parallel_fan_out_emits_all_branches(cp):
    d = _par_start(cp)
    assert d["action"] == "invoke_agents_parallel" and d["state_id"] == "scanning"
    bids = {t["branch_id"] for t in d["tasks"]}
    assert bids == {"sast", "deps"}
    assert {t["agent"] for t in d["tasks"]} == {"vera", "echo"}


def test_parallel_batch_fan_in_routes_once(cp):
    _par_start(cp)
    d = _par_step(
        cp,
        [
            _entry("sast", "vera", passed=True, confidence="CERTAIN"),
            _entry("deps", "echo", passed=True, confidence="PROBABLE"),
        ],
    )
    assert d["action"] == "complete"


def test_parallel_weakest_confidence_escalates(cp):
    _par_start(cp)
    d = _par_step(
        cp,
        [
            _entry("sast", "vera", passed=True, confidence="CERTAIN"),
            _entry("deps", "echo", passed=False, confidence="UNCERTAIN"),
        ],
    )
    assert d["action"] == "escalate_to_user" and d["previous_state"] == "scanning"


def test_parallel_recovery_reissues_fan_out(cp):
    _par_start(cp)
    # A kill before the batch lands: recovery re-issues the whole fan-out.
    orig = dict(pb_mod.PLAYBOOKS)
    pb_mod.PLAYBOOKS["par-test"] = ParPlaybook
    try:
        directives = recover_pending(cp, session_id=SID, playbook="par-test")
    finally:
        pb_mod.PLAYBOOKS.clear()
        pb_mod.PLAYBOOKS.update(orig)
    assert len(directives) == 1 and directives[0]["action"] == "invoke_agents_parallel"
    assert {t["branch_id"] for t in directives[0]["tasks"]} == {"sast", "deps"}


def test_parallel_rejects_unknown_branch_id(cp):
    _par_start(cp)
    d = _par_step(cp, [_entry("nope", "vera", passed=True, confidence="CERTAIN")])
    assert d["action"] == "invoke_agents_parallel"  # bounded retry re-issues fan-out


def test_parallel_missing_branch_retries(cp):
    _par_start(cp)
    d = _par_step(cp, [_entry("sast", "vera", passed=True, confidence="CERTAIN")])
    assert d["action"] == "invoke_agents_parallel"  # incomplete batch -> retry


def test_parallel_rejects_non_parallel_fan_in_agent(cp):
    _par_start(cp)
    # A single-agent result posted to a fan-out state is an error, not a silent
    # accept (the driver must fan results in under agent "__parallel__").
    d = ParPlaybook(cp).step(
        session_id=SID,
        run_id=RID,
        agent="vera",
        result=[_entry("sast", "vera", passed=True, confidence="CERTAIN")],
    )
    assert d["action"] == "error"
    assert any("__parallel__" in e for e in d["errors"])


# ---------------------------------------------------------------------------
# Planned-gate HITL
# ---------------------------------------------------------------------------


class GateMachine(StateMachine):
    intake = State(initial=True)
    working = State()
    review = State()
    applied = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)
    start = intake.to(working)
    work_done = working.to(review)
    approve = review.to(applied)
    reject = review.to(working)
    applied_done = applied.to(complete)
    to_unknown = working.to(unknown)
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(working)
    abort = (
        working.to(error)
        | review.to(error)
        | applied.to(error)
        | unknown.to(error)
        | awaiting_clarification.to(error)
    )


_ONE_C = {"required": {"confidence": str}, "optional": {}}
WORK = PrimitiveSpec("WORK", "skribble", _ONE_C, "do work")
APPLIED = PrimitiveSpec("APPLIED", "skribble", _ONE_C, "apply")


class GatePlaybook(BasePlaybook):
    NAME = "gate-test"
    machine_cls = GateMachine
    PRIMITIVE_BY_STATE = {"working": WORK, "applied": APPLIED}
    GATE_STATES = frozenset({"review"})

    def initial_transition(self, ctx):
        self.sm.send("start")
        return "working"

    def route_after(self, state, ctx, summary):
        if state == "working":
            self.sm.send("work_done")
        elif state == "applied":
            self.sm.send("applied_done")

    def gate_questions(self, state, ctx):
        return [
            {
                "id": state,
                "label": "Approve?",
                "prompt": "Approve the plan?",
                "options": ["approve", "revise"],
                "allowOther": True,
            }
        ]

    def route_user(self, state, ctx, response):
        ans = response.get("answer") if isinstance(response, dict) else str(response)
        if ans == "approve":
            self.sm.send("approve")
        else:
            self.sm.send("reject")


def _gate_start(cp):
    return GatePlaybook(cp).start(session_id=SID, run_id=RID, goal="gate")


def _gate_step(cp, agent, result):
    return GatePlaybook(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


def test_gate_pauses_at_declared_state(cp):
    _gate_start(cp)
    d = _gate_step(cp, "skribble", {"confidence": "CERTAIN"})
    assert d["action"] == "escalate_to_user"
    assert d["previous_state"] == "review" and d["unknown_reason"] == "gate:review"
    # The run is parked AWAITING_USER at the gate state id.
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER and rec.current_state_id == "review"


def test_gate_approve_routes_forward(cp):
    _gate_start(cp)
    _gate_step(cp, "skribble", {"confidence": "CERTAIN"})
    d = _gate_step(cp, "user", {"answer": "approve"})
    assert d["action"] == "invoke_agent" and d["state_id"] == "applied"


def test_gate_reject_routes_back(cp):
    _gate_start(cp)
    _gate_step(cp, "skribble", {"confidence": "CERTAIN"})
    d = _gate_step(cp, "user", {"answer": "revise"})
    assert d["action"] == "invoke_agent" and d["state_id"] == "working"


def test_gate_recovery_re_presents_the_gate(cp):
    _gate_start(cp)
    _gate_step(cp, "skribble", {"confidence": "CERTAIN"})
    orig = dict(pb_mod.PLAYBOOKS)
    pb_mod.PLAYBOOKS["gate-test"] = GatePlaybook
    try:
        directives = recover_pending(cp, session_id=SID, playbook="gate-test")
    finally:
        pb_mod.PLAYBOOKS.clear()
        pb_mod.PLAYBOOKS.update(orig)
    assert len(directives) == 1 and directives[0]["action"] == "escalate_to_user"
    assert directives[0]["previous_state"] == "review"


# ---------------------------------------------------------------------------
# start() precondition guard + cycle-neutral result_payload
# ---------------------------------------------------------------------------


class GuardMachine(StateMachine):
    intake = State(initial=True)
    working = State()
    complete = State(final=True)
    error = State(final=True)
    start = intake.to(working)
    work_done = working.to(complete)
    abort = intake.to(error) | working.to(error)


class GuardPlaybook(BasePlaybook):
    NAME = "guard-test"
    machine_cls = GuardMachine
    PRIMITIVE_BY_STATE = {"working": WORK}

    def initial_transition(self, ctx):
        raise RuntimeError("precondition not satisfied")


def test_start_guard_turns_precondition_failure_into_error(cp):
    d = GuardPlaybook(cp).start(session_id=SID, run_id=RID, goal="x")
    assert d["action"] == "error"
    assert any("precondition not satisfied" in e for e in d["errors"])


class OkGuardPlaybook(BasePlaybook):
    NAME = "ok-test"
    machine_cls = GuardMachine
    PRIMITIVE_BY_STATE = {"working": WORK}

    def initial_transition(self, ctx):
        self.sm.send("start")
        return "working"

    def route_after(self, state, ctx, summary):
        self.sm.send("work_done")


def test_result_payload_default_is_cycle_neutral(cp):
    OkGuardPlaybook(cp).start(session_id=SID, run_id=RID, goal="x")
    d = OkGuardPlaybook(cp).step(
        session_id=SID, run_id=RID, agent="skribble", result={"confidence": "CERTAIN"}
    )
    assert d["action"] == "complete"
    # Base result_payload carries no cycle vocabulary (no verify_verdict/gaps).
    assert set(d["result"]) == {"met", "iterations"}
