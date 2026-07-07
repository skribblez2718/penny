"""Tests for the orchestration CLI (start/step/status; no --state)."""

import json

import pytest

from orchestration import cli


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv("PENNY_ORCH_DB", str(tmp_path / "orch.db"))
    # Point obs at a dead port so the CLI never touches the live server.
    monkeypatch.setenv("PI_OBSERVABILITY_URL", "http://localhost:1")
    from orchestration import obs_client

    obs_client.reset_circuit_breaker()
    yield


def _run(capsys, argv) -> dict:
    rc = cli.main(default_playbook="reference-cycle", argv=argv)
    out = capsys.readouterr().out.strip()
    return json.loads(out), rc


def test_start_emits_first_directive(capsys):
    d, rc = _run(capsys, ["start", "--session-id", "s1", "--run-id", "r1", "--goal", "prove"])
    assert rc == 0
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "echo" and d["state_id"] == "observing"
    assert d["run_id"] == "r1" and "orchestrator_state" not in d


def test_step_advances(capsys):
    _run(capsys, ["start", "--session-id", "s1", "--run-id", "r1", "--goal", "g"])
    d, rc = _run(
        capsys,
        [
            "step",
            "--session-id",
            "s1",
            "--run-id",
            "r1",
            "--agent",
            "echo",
            "--result",
            json.dumps({"observe_complete": True, "confidence": "PROBABLE"}),
        ],
    )
    assert rc == 0 and d["state_id"] == "framing" and d["agent"] == "annie"


def test_status(capsys):
    _run(capsys, ["start", "--session-id", "s1", "--run-id", "r1"])
    d, rc = _run(capsys, ["status", "--session-id", "s1", "--run-id", "r1"])
    assert d["action"] == "status" and d["state"] == "observing"


def test_unknown_playbook_errors(capsys):
    rc = cli.main(argv=["start", "--playbook", "nope", "--session-id", "s", "--run-id", "r"])
    out = json.loads(capsys.readouterr().out.strip())
    assert rc == 1 and out["action"] == "error" and "unknown playbook" in out["errors"][0]


def test_invalid_constraints_json_errors(capsys):
    d, rc = _run(capsys, ["start", "--session-id", "s", "--run-id", "r", "--constraints", "{bad"])
    assert rc == 1 and d["action"] == "error" and "constraints" in d["errors"][0]


def test_recover_no_pending_returns_status_unknown(capsys):
    d, rc = _run(capsys, ["recover", "--session-id", "s-none", "--run-id", "r-none"])
    assert rc == 0 and d["action"] == "status" and d["state"] == "unknown"


def test_recover_resumes_pending_run(capsys):
    # start a run, advance one step so it's pending mid-flow, then recover it.
    _run(capsys, ["start", "--session-id", "s-rec", "--run-id", "r-rec", "--goal", "g"])
    _run(
        capsys,
        [
            "step",
            "--session-id",
            "s-rec",
            "--run-id",
            "r-rec",
            "--agent",
            "echo",
            "--result",
            json.dumps({"observe_complete": True, "confidence": "PROBABLE"}),
        ],
    )  # now at framing (running)
    d, rc = _run(capsys, ["recover", "--session-id", "s-rec", "--run-id", "r-rec"])
    assert rc == 0 and d["action"] == "invoke_agent" and d["state_id"] == "framing"
    assert d["run_id"] == "r-rec"


def test_recover_is_playbook_scoped(capsys, monkeypatch):
    # A pending reference-cycle run must NOT be recovered by a DIFFERENT skill
    # sharing the session. Register a second playbook to scope against.
    from orchestration import playbooks as pb_mod
    from orchestration.playbooks.reference_cycle import ReferenceCycle

    class _OtherSkill(ReferenceCycle):
        NAME = "other-skill"

    monkeypatch.setitem(pb_mod.PLAYBOOKS, "other-skill", _OtherSkill)
    _run(capsys, ["start", "--session-id", "s-x", "--run-id", "r-x", "--goal", "g"])
    rc = cli.main(
        default_playbook="other-skill", argv=["recover", "--session-id", "s-x", "--run-id", "r-x"]
    )
    out = json.loads(capsys.readouterr().out.strip())
    assert rc == 0 and out["action"] == "status" and out["state"] == "unknown"


def test_no_state_flag_supported(capsys):
    # The CLI must NOT accept a --state flag (state lives in the checkpointer).
    with pytest.raises(SystemExit):
        cli.main(
            default_playbook="reference-cycle",
            argv=["step", "--session-id", "s", "--run-id", "r", "--state", "{}"],
        )
