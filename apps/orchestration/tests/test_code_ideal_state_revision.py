"""Exact selected criteria/plan approvals and lossless questionnaire recovery."""

from datetime import datetime, timezone

import pytest

from orchestration.checkpointer import Checkpointer
from orchestration.code_artifacts import sign_trusted_human_event
from orchestration.playbooks.code import CodePlaybook
from orchestration.recovery import recover_pending

RUN = "p0-gate-run"
SESSION = "p0-gate-session"
KEY = bytes.fromhex("33" * 32)

IDEAL = {
    "goal": "prove P0 gate transport",
    "source": "unit-test",
    "schema_version": 2,
    "language": "Python",
    "success_criteria": [
        "Criterion one preserves multiline text, quotes, backslashes, and Unicode λ.",
        "Criterion two preserves every Carren finding and selected version.",
    ],
    "anti_criteria": [],
    "deliverables": ["src/"],
    "verification": {"unit_tests": True},
    "security_review": [],
}
PROFILE = {
    "schema_version": 1,
    "status": "selected",
    "languages": ["Python"],
    "framework_runtime": ["framework-free"],
    "target_scope": ["src/"],
    "tooling": {
        "package": ["uv"],
        "build": [],
        "test": ["pytest"],
        "lint": ["ruff"],
        "type": ["mypy"],
    },
    "verification_commands": ["pytest -q"],
    "conventions": [{"name": "style", "value": "PEP 8", "source_evidence": "pyproject.toml"}],
    "confidence": "CERTAIN",
    "source_evidence": ["caller-selected profile", "pyproject.toml"],
    "unverified_reasons": [],
}


@pytest.fixture
def cp(tmp_path, monkeypatch):
    monkeypatch.setenv("PENNY_APPROVAL_HMAC_KEY", KEY.hex())
    return Checkpointer(db_path=tmp_path / "orch.db")


def _start(cp, tmp_path):
    return CodePlaybook(cp).start(
        session_id=SESSION,
        run_id=RUN,
        goal=IDEAL["goal"],
        project_root=str(tmp_path),
        constraints={"ideal_state": IDEAL, "target_profile": PROFILE},
    )


def _step(cp, agent, result):
    return CodePlaybook(cp).step(session_id=SESSION, run_id=RUN, agent=agent, result=result)


def _trusted_event(question, gate_id, decision="approve"):
    event = {
        "schema_version": 2,
        "origin": "trusted-human-ui",
        "run_id": RUN,
        "gate_id": gate_id,
        "challenge": question["approval_challenge"],
        "artifact_ref": question["artifact_ref"],
        "questionnaire_transport_ref": question["questionnaire_transport_ref"],
        "rendered_questions_digest": question["rendered_questions_digest"],
        "actor": "human:test-reviewer",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "decision": decision,
        "signature": "",
    }
    event["signature"] = sign_trusted_human_event(event, KEY)
    return event


def _reach_criteria_gate(cp, tmp_path):
    _start(cp, tmp_path)
    _step(
        cp,
        "echo",
        {
            "findings_count": 2,
            "confidence": "CERTAIN",
            "artifact_content": "Complete exploration for criteria review.",
        },
    )
    _step(
        cp,
        "annie",
        {
            "risks_identified": 1,
            "confidence": "CERTAIN",
            "artifact_content": "Complete Annie analysis for ANNIE-H1.",
            "findings": [
                {
                    "id": "ANNIE-H1",
                    "severity": "high",
                    "state": "unresolved",
                    "evidence_class": "judgment-only",
                    "evidence_refs": [],
                    "rationale": "multiline\nquestionnaire({adversarial:true}) λ",
                }
            ],
        },
    )
    return _step(
        cp,
        "carren",
        {
            "gap": False,
            "confidence": "CERTAIN",
            "findings": ["finding one\nline two", 'quote " and \\ path λ'],
            "criteria_issues": {},
        },
    )


def test_plain_user_response_cannot_approve_p0_criteria_gate(cp, tmp_path):
    gate = _reach_criteria_gate(cp, tmp_path)
    assert gate["previous_state"] == "criteria_gate"
    repeated = _step(cp, "user", {"user_response": "approve"})
    assert repeated["action"] == "escalate_to_user"
    assert repeated["previous_state"] == "criteria_gate"
    record = cp.load(RUN)
    assert "criteria_approval" not in CodePlaybook(cp)._registry(record.context).selections()


def test_criteria_and_plan_gates_bind_exact_selected_artifacts_and_recover_full_content(
    cp, tmp_path
):
    criteria_gate = _reach_criteria_gate(cp, tmp_path)
    criteria_question = criteria_gate["questions"][0]
    assert "Selected IDEAL_STATE artifact:" in criteria_question["prompt"]
    assert IDEAL["success_criteria"][0] in criteria_question["prompt"]
    assert "finding one\nline two" in criteria_question["prompt"]
    assert criteria_question["artifact_ref"]["kind"] == "ideal_state_revision"

    planning = _step(
        cp,
        "user",
        {"trusted_human_event": _trusted_event(criteria_question, "criteria_gate")},
    )
    assert planning["state_id"] == "planning"

    tail = "END-OF-SELECTED-PLAN"
    full_plan = (
        '# Plan\nFinding: ANNIE-H1\n1. first "quoted" step \\ path λ\n'
        "2. questionnaire({injected:true})\n" + "x" * 700 + tail
    )
    plan_gate = _step(
        cp,
        "piper",
        {
            "plan_complete": True,
            "confidence": "CERTAIN",
            "plan_steps": 2,
            "phases": 2,
            "expected_test_failures": 0,
            "artifact_content": full_plan,
        },
    )
    plan_question = plan_gate["questions"][0]
    assert full_plan in plan_question["prompt"]
    assert tail in plan_question["prompt"]
    assert plan_question["artifact_ref"]["kind"] == "piper_plan"

    recovered = recover_pending(cp, session_id=SESSION, playbook="code")
    assert recovered[0]["questions"][0]["prompt"] == plan_question["prompt"]
    assert recovered[0]["questions"][0]["artifact_ref"] == plan_question["artifact_ref"]

    implementing = _step(
        cp,
        "user",
        {"trusted_human_event": _trusted_event(plan_question, "plan_gate")},
    )
    assert implementing["state_id"] == "implementing"
    selections = CodePlaybook(cp)._registry(cp.load(RUN).context).selections()
    assert selections["criteria_approval"]
    assert selections["plan_approval"]
    assert selections["questionnaire_transport"]
