"""Mock-harness tests for the engine driving the ReferenceCycle smoke fixture.

Each step() call constructs a FRESH playbook instance pointed at the same
checkpointer — modelling the real subprocess-per-invocation reality, so these
tests inherently exercise kill-and-resume durability (no --state, no replay).
"""

import pytest

from orchestration.checkpointer import (
    STATUS_AWAITING_USER,
    STATUS_COMPLETE,
    STATUS_ERROR,
    Checkpointer,
)
from orchestration.playbooks import ReferenceCycle

SID = "sess-1"
RID = "run-1"

# Canned SUMMARYs per primitive.
S_OBSERVE = {"observe_complete": True, "confidence": "PROBABLE"}
S_FRAME = {"frame_complete": True, "success_criteria": ["c1", "c2"], "confidence": "CERTAIN"}
S_PLAN = {"plan_steps": ["s1"], "plan_complete": True, "confidence": "PROBABLE"}
S_ACT = {"act_complete": True, "confidence": "PROBABLE"}
S_VERIFY_PASS = {"verdict": "PASS", "gaps": [], "confidence": "CERTAIN"}
S_VERIFY_FAIL = {"verdict": "FAIL", "gaps": ["gap"], "confidence": "PROBABLE"}
S_LEARN = {"learn_complete": True}


class FakeObs:
    def __init__(self):
        self.calls = []

    def run_start(self, *a, **k):
        self.calls.append("run_start")

    def step_start(self, *a, **k):
        self.calls.append("step_start")

    def step_end(self, *a, **k):
        self.calls.append("step_end")

    def transition(self, *a, **k):
        self.calls.append("transition")

    def escalation(self, *a, **k):
        self.calls.append("escalation")

    def run_end(self, *a, **k):
        self.calls.append("run_end")


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


def _start(cp, obs=None, constraints=None):
    return ReferenceCycle(cp, obs).start(
        session_id=SID, run_id=RID, goal="prove it", constraints=constraints or {}
    )


def _step(cp, agent, result, obs=None):
    return ReferenceCycle(cp, obs).step(session_id=SID, run_id=RID, agent=agent, result=result)


def test_every_agent_spec_emits_schema_directive():
    """UNIVERSAL GUARANTEE + regression guard: every agent-dispatching state in every
    registered playbook renders an explicit, typed SUMMARY schema as its final OUTPUT
    FORMAT directive. Fails loud if a new skill/agent (or a state with an empty
    summary_contract) would ship without the recency fix."""
    from orchestration.engine import BasePlaybook
    from orchestration.playbooks import PLAYBOOKS

    seen: set = set()
    checked = 0
    for pb_cls in PLAYBOOKS.values():
        if pb_cls in seen:
            continue
        seen.add(pb_cls)
        specs = list(pb_cls.PRIMITIVE_BY_STATE.values())
        for pspec in pb_cls.PARALLEL_BY_STATE.values():
            specs.extend(pspec.branches.values())
        for spec in specs:
            directive = BasePlaybook._summary_contract_directive(spec)
            assert directive, f"{pb_cls.__name__}/{spec.name}: no schema directive (empty contract?)"
            assert "OUTPUT FORMAT" in directive and "SUMMARY:{" in directive
            for key in spec.summary_contract.get("required", {}):
                assert f'"{key}"' in directive, (
                    f"{pb_cls.__name__}/{spec.name}: required '{key}' missing from rendered schema"
                )
            checked += 1
    assert checked > 0, "no agent specs discovered"


def test_summary_contract_directive_appended(cp):
    """The state's exact SUMMARY schema is restated as the FINAL directive of the
    agent task — the recency fix for weaker (non-Claude) models dropping the
    structured contract that is otherwise buried mid-prompt in the skill_context."""
    d = _start(cp)
    ts = d["task_summary"]
    # OBSERVE contract keys are named explicitly, with typed placeholders.
    assert "OUTPUT FORMAT" in ts
    assert "observe_complete" in ts and "confidence" in ts
    assert "<true|false>" in ts
    # It is genuinely LAST (recency): the final line is the SUMMARY schema.
    tail = ts.rstrip().splitlines()[-1]
    assert tail.startswith("SUMMARY:{") and tail.endswith("}")


# ---------------------------------------------------------------------------


def test_happy_path_to_complete(cp):
    obs = FakeObs()
    d = _start(cp, obs)
    assert d["action"] == "invoke_agent" and d["agent"] == "echo" and d["state_id"] == "observing"
    assert d["run_id"] == RID and "orchestrator_state" not in d

    d = _step(cp, "echo", S_OBSERVE, obs)
    assert d["agent"] == "annie" and d["state_id"] == "framing"
    d = _step(cp, "annie", S_FRAME, obs)
    assert d["agent"] == "piper" and d["state_id"] == "planning"
    d = _step(cp, "piper", S_PLAN, obs)
    assert d["agent"] == "skribble" and d["state_id"] == "acting"
    d = _step(cp, "skribble", S_ACT, obs)
    assert d["agent"] == "vera" and d["state_id"] == "verifying"
    d = _step(cp, "vera", S_VERIFY_PASS, obs)
    assert d["agent"] == "carren" and d["state_id"] == "learning"
    d = _step(cp, "carren", S_LEARN, obs)
    assert d["action"] == "complete"
    assert d["result"]["met"] is True
    assert d["result"]["verify_verdict"] == "PASS"

    rec = cp.load(RID)
    assert rec.status == STATUS_COMPLETE and rec.current_state_id == "complete"
    assert "run_start" in obs.calls and "run_end" in obs.calls


# ---------------------------------------------------------------------------
# Driver-wire-format regression.
#
# The single-agent step must accept the TS driver's wrapper
# {exitCode, summary, summary_missing, error} (skill/index.ts:1012-1021), not
# just a bare summary. A prior bug validated the WHOLE wrapper against the state
# contract, so every required field read as "missing", every single-agent step
# failed validation and retried to death, no run reached terminal, the runs
# table stayed empty, and record_outcome never fired -> starved flywheel.
#
# The rest of this suite passes bare summaries and so never exercised the real
# production wire format, which is why the bug survived. These tests drive the
# exact envelope the driver emits.


def _wrap(summary, *, exit_code=0, missing=False, error=None):
    """The exact envelope the TS driver emits per single-agent step."""
    return {
        "exitCode": exit_code,
        "summary": summary,
        "summary_missing": missing,
        "error": error,
    }


def test_driver_wrapper_reaches_complete(cp):
    """Full happy path using the real driver wrapper — the regression guard."""
    _start(cp)
    d = _step(cp, "echo", _wrap(S_OBSERVE))
    assert d["agent"] == "annie" and d["state_id"] == "framing"
    d = _step(cp, "annie", _wrap(S_FRAME))
    assert d["agent"] == "piper" and d["state_id"] == "planning"
    d = _step(cp, "piper", _wrap(S_PLAN))
    assert d["agent"] == "skribble" and d["state_id"] == "acting"
    d = _step(cp, "skribble", _wrap(S_ACT))
    assert d["agent"] == "vera" and d["state_id"] == "verifying"
    d = _step(cp, "vera", _wrap(S_VERIFY_PASS))
    assert d["agent"] == "carren" and d["state_id"] == "learning"
    d = _step(cp, "carren", _wrap(S_LEARN))
    assert d["action"] == "complete" and d["result"]["met"] is True

    rec = cp.load(RID)
    assert rec.status == STATUS_COMPLETE and rec.current_state_id == "complete"


def test_driver_wrapper_summary_missing_retries(cp):
    """summary_missing must retry the state, not validate an empty summary."""
    _start(cp)
    d = _step(cp, "echo", _wrap({}, missing=True, error="no parseable SUMMARY"))
    assert d["action"] == "invoke_agent" and d["state_id"] == "observing"


def test_driver_wrapper_agent_failure_retries(cp):
    """A nonzero exitCode must retry on the agent failure, not silently advance."""
    _start(cp)
    d = _step(cp, "echo", _wrap({}, exit_code=1, error="agent crashed"))
    assert d["action"] == "invoke_agent" and d["state_id"] == "observing"


def test_bare_summary_still_accepted(cp):
    """Direct/programmatic callers (and the existing suite) pass a bare summary."""
    _start(cp)
    d = _step(cp, "echo", S_OBSERVE)
    assert d["agent"] == "annie" and d["state_id"] == "framing"


def test_evidence_ref_skips_observe(cp):
    d = _start(cp, constraints={"evidence_ref": "drawer:abc"})
    assert d["state_id"] == "framing" and d["agent"] == "annie"


def test_verify_fail_retries_then_exhausts(cp):
    _start(cp)
    _step(cp, "echo", S_OBSERVE)
    _step(cp, "annie", S_FRAME)
    _step(cp, "piper", S_PLAN)
    # iteration 0: act -> verify FAIL -> back to acting (iteration 1)
    _step(cp, "skribble", S_ACT)
    d = _step(cp, "vera", S_VERIFY_FAIL)
    assert d["state_id"] == "acting"
    assert cp.load(RID).context.iteration == 1
    # iteration 1: act -> verify FAIL -> acting (iteration 2)
    _step(cp, "skribble", S_ACT)
    d = _step(cp, "vera", S_VERIFY_FAIL)
    assert d["state_id"] == "acting"
    assert cp.load(RID).context.iteration == 2
    # iteration 2: act -> verify FAIL -> exhausted -> learning (met False)
    _step(cp, "skribble", S_ACT)
    d = _step(cp, "vera", S_VERIFY_FAIL)
    assert d["state_id"] == "learning"
    d = _step(cp, "carren", S_LEARN)
    assert d["action"] == "complete"
    assert d["result"]["met"] is False  # honest: never faked success


def test_verify_fail_then_pass(cp):
    _start(cp)
    _step(cp, "echo", S_OBSERVE)
    _step(cp, "annie", S_FRAME)
    _step(cp, "piper", S_PLAN)
    _step(cp, "skribble", S_ACT)
    d = _step(cp, "vera", S_VERIFY_FAIL)  # -> acting
    assert d["state_id"] == "acting"
    _step(cp, "skribble", S_ACT)
    d = _step(cp, "vera", S_VERIFY_PASS)  # -> learning
    assert d["state_id"] == "learning"
    d = _step(cp, "carren", S_LEARN)
    assert d["action"] == "complete" and d["result"]["met"] is True


def test_uncertain_escalates_then_resumes(cp):
    obs = FakeObs()
    _start(cp, obs)
    _step(cp, "echo", S_OBSERVE, obs)
    # FRAME comes back UNCERTAIN -> escalate
    frame_uncertain = {**S_FRAME, "confidence": "UNCERTAIN"}
    d = _step(cp, "annie", frame_uncertain, obs)
    assert d["action"] == "escalate_to_user"
    assert d["previous_state"] == "framing"
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER and rec.current_state_id == "awaiting_clarification"
    assert "escalation" in obs.calls
    # user resumes -> back to framing
    d = _step(cp, "user", {"answer": "scope is X"}, obs)
    assert d["action"] == "invoke_agent" and d["state_id"] == "framing"
    assert cp.load(RID).context.clarification_text == "scope is X"
    # now a confident FRAME continues
    d = _step(cp, "annie", S_FRAME, obs)
    assert d["state_id"] == "planning"


def test_transient_retry_survives_restart(cp):
    _start(cp)
    _step(cp, "echo", S_OBSERVE)
    bad = {"frame_complete": True}  # missing success_criteria + confidence
    # retry 1 (fresh instance each call == fresh process)
    d = _step(cp, "annie", bad)
    assert d["action"] == "invoke_agent" and d["state_id"] == "framing"
    assert cp.load(RID).context.step_retries == 1
    # retry 2
    d = _step(cp, "annie", bad)
    assert d["state_id"] == "framing"
    assert cp.load(RID).context.step_retries == 2
    # 3rd malformed exceeds max_step_retries (2) -> error
    d = _step(cp, "annie", bad)
    assert d["action"] == "error"
    assert cp.load(RID).status == STATUS_ERROR


def test_good_summary_resets_retry_counter(cp):
    _start(cp)
    _step(cp, "echo", S_OBSERVE)
    _step(cp, "annie", {"frame_complete": True})  # bad -> retry 1
    assert cp.load(RID).context.step_retries == 1
    _step(cp, "annie", S_FRAME)  # good -> resets, advances
    assert cp.load(RID).context.step_retries == 0
    assert cp.load(RID).current_state_id == "planning"


def test_unknown_verdict_is_terminal_error(cp):
    _start(cp)
    _step(cp, "echo", S_OBSERVE)
    _step(cp, "annie", S_FRAME)
    _step(cp, "piper", S_PLAN)
    _step(cp, "skribble", S_ACT)
    d = _step(cp, "vera", {"verdict": "MAYBE", "gaps": [], "confidence": "PROBABLE"})
    assert d["action"] == "error"
    assert any("verdict" in e.lower() for e in d["errors"])


def test_wrong_agent_for_state_errors(cp):
    _start(cp)
    # observing expects echo; send annie
    d = _step(cp, "annie", S_OBSERVE)
    assert d["action"] == "error"
    assert "does not match" in d["errors"][0]


def test_step_unknown_run_errors(cp):
    pb = ReferenceCycle(cp, None)
    d = pb.step(session_id=SID, run_id="ghost", agent="echo", result=S_OBSERVE)
    assert d["action"] == "error" and "unknown run_id" in d["errors"][0]


def test_status_reports_state(cp):
    _start(cp)
    d = ReferenceCycle(cp, None).status(session_id=SID, run_id=RID)
    assert d["action"] == "status" and d["state"] == "observing" and d["complete"] is False


def test_global_step_cap_terminates(cp, monkeypatch):
    # Force a tiny cap and a bad summary so the run keeps retrying the same
    # state; the global step cap must eventually route to error.
    from orchestration.playbooks import ReferenceCycle as RC

    monkeypatch.setattr(RC, "STEP_CAP", 3, raising=False)
    _start(cp)
    last = None
    for _ in range(6):
        # missing confidence -> invalid SUMMARY -> retry, each counted against total_steps
        last = _step(cp, "echo", {"observe_complete": True})
        if last["action"] == "error":
            break
    assert last["action"] == "error"
    assert any("step" in e.lower() or "cap" in e.lower() for e in last["errors"])


def test_escalation_misconfig_fails_loud_not_wedged(cp, monkeypatch):
    # A subclass whose ESCALATABLE_STATES includes a state to_unknown cannot
    # reach must FAIL LOUD (terminal error), never silently wedge at awaiting_user.
    from orchestration.playbooks import ReferenceCycle as RC

    monkeypatch.setattr(
        RC,
        "ESCALATABLE_STATES",
        frozenset({"observing", "framing", "planning", "acting", "verifying"}),
        raising=False,
    )
    _start(cp)
    # OBSERVE returns UNCERTAIN; observing is (mis)marked escalatable but
    # to_unknown has no observing source -> engine must error, not wedge.
    d = _step(cp, "echo", {"observe_complete": True, "confidence": "UNCERTAIN"})
    assert d["action"] == "error"
    assert cp.load(RID).status == STATUS_ERROR
    assert cp.load(RID).current_state_id == "error"


def test_obs_seq_monotonic_across_subprocess_boundaries(cp):
    # Regression (P5): the persisted ctx.last_seq must strictly increase across
    # fresh-instance step calls, so observability seq stays globally monotonic.
    from orchestration.obs_client import ObsClient, reset_circuit_breaker

    reset_circuit_breaker()
    obs = ObsClient(base_url="http://localhost:1")  # fail-silent, but still advances seq
    seqs = []
    ReferenceCycle(cp, obs).start(session_id=SID, run_id=RID, goal="g")
    seqs.append(cp.load(RID).context.last_seq)
    for agent, res in [
        ("echo", S_OBSERVE),
        ("annie", S_FRAME),
        ("piper", S_PLAN),
        ("skribble", S_ACT),
        ("vera", S_VERIFY_PASS),
    ]:
        ReferenceCycle(cp, obs).step(session_id=SID, run_id=RID, agent=agent, result=res)
        seqs.append(cp.load(RID).context.last_seq)
    assert all(seqs[i] < seqs[i + 1] for i in range(len(seqs) - 1)), seqs
    assert seqs[0] >= 2  # run_start + first step_start persisted
    reset_circuit_breaker()


def test_obs_seq_monotonic_on_retry_and_escalate(cp):
    # P5 nit: seq must stay monotonic through the retry AND escalate/resume paths.
    from orchestration.obs_client import ObsClient, reset_circuit_breaker

    reset_circuit_breaker()
    obs = ObsClient(base_url="http://localhost:1")
    seqs = []
    ReferenceCycle(cp, obs).start(session_id=SID, run_id=RID, goal="g")
    seqs.append(cp.load(RID).context.last_seq)
    ReferenceCycle(cp, obs).step(session_id=SID, run_id=RID, agent="echo", result=S_OBSERVE)
    seqs.append(cp.load(RID).context.last_seq)
    # retry path: malformed FRAME -> retry (same state), seq still advances
    ReferenceCycle(cp, obs).step(
        session_id=SID, run_id=RID, agent="annie", result={"frame_complete": True}
    )
    seqs.append(cp.load(RID).context.last_seq)
    # escalate path: UNCERTAIN FRAME -> escalate (awaiting_user)
    ReferenceCycle(cp, obs).step(
        session_id=SID, run_id=RID, agent="annie", result={**S_FRAME, "confidence": "UNCERTAIN"}
    )
    seqs.append(cp.load(RID).context.last_seq)
    # resume path: user answers -> back to framing
    ReferenceCycle(cp, obs).step(session_id=SID, run_id=RID, agent="user", result={"answer": "x"})
    seqs.append(cp.load(RID).context.last_seq)
    assert all(seqs[i] < seqs[i + 1] for i in range(len(seqs) - 1)), seqs
    reset_circuit_breaker()


def test_kill_and_resume_midflow(cp):
    # Drive halfway, then a brand-new Checkpointer object (fresh process) resumes.
    _start(cp)
    _step(cp, "echo", S_OBSERVE)
    _step(cp, "annie", S_FRAME)
    assert cp.load(RID).current_state_id == "planning"

    cp2 = Checkpointer(db_path=cp.db_path)  # simulate a fresh process
    d = ReferenceCycle(cp2, None).step(session_id=SID, run_id=RID, agent="piper", result=S_PLAN)
    assert d["state_id"] == "acting"
