"""P0 stage artifacts are selected, reference-handed-off, and fresh-process recoverable."""

from datetime import datetime, timezone

from orchestration.checkpointer import Checkpointer
from orchestration.code_artifacts import ArtifactRegistry, sign_trusted_human_event
from orchestration.playbooks.code import CodePlaybook

KEY = bytes.fromhex("44" * 32)
IDEAL = {
    "goal": "propagate findings",
    "source": "test",
    "schema_version": 2,
    "language": "Rust",
    "success_criteria": ["All findings propagate."],
    "deliverables": ["src/"],
    "verification": {"unit_tests": True},
    "security_review": [],
}
PROFILE = {
    "schema_version": 1,
    "status": "selected",
    "languages": ["Rust"],
    "framework_runtime": ["framework-free"],
    "target_scope": ["src/"],
    "tooling": {
        "package": ["cargo"],
        "build": ["cargo build"],
        "test": ["cargo test"],
        "lint": ["cargo clippy"],
        "type": [],
    },
    "verification_commands": ["cargo test"],
    "conventions": [{"name": "format", "value": "rustfmt", "source_evidence": "rustfmt.toml"}],
    "confidence": "CERTAIN",
    "source_evidence": ["Cargo.toml", "caller-selected profile"],
    "unverified_reasons": [],
}


def _step(cp, agent, result):
    return CodePlaybook(cp).step(session_id="session", run_id="run", agent=agent, result=result)


def _event(question):
    event = {
        "schema_version": 2,
        "origin": "trusted-human-ui",
        "run_id": "run",
        "gate_id": "criteria_gate",
        "challenge": question["approval_challenge"],
        "artifact_ref": question["artifact_ref"],
        "questionnaire_transport_ref": question["questionnaire_transport_ref"],
        "rendered_questions_digest": question["rendered_questions_digest"],
        "actor": "human:reviewer",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "decision": "approve",
        "response": "accept",
        "signature": "",
    }
    event["signature"] = sign_trusted_human_event(event, KEY)
    return event


def test_new_annie_obligation_reaches_plan_and_recovered_registry(tmp_path, monkeypatch):
    monkeypatch.setenv("PENNY_APPROVAL_HMAC_KEY", KEY.hex())
    database = tmp_path / "orch.db"
    cp = Checkpointer(db_path=database)
    CodePlaybook(cp).start(
        session_id="session",
        run_id="run",
        goal=IDEAL["goal"],
        project_root=str(tmp_path),
        constraints={"ideal_state": IDEAL, "target_profile": PROFILE},
    )
    _step(
        cp,
        "echo",
        {
            "findings_count": 1,
            "confidence": "CERTAIN",
            "artifact_content": "Complete exploration evidence.",
        },
    )
    high = {
        "id": "ANNIE-NEW-CRITICAL",
        "severity": "critical",
        "state": "unresolved",
        "evidence_class": "judgment-only",
        "evidence_refs": [],
        "rationale": "newly discovered obligation",
    }
    _step(
        cp,
        "annie",
        {
            "risks_identified": 1,
            "findings": [high],
            "confidence": "CERTAIN",
            "artifact_content": "Complete analysis for ANNIE-NEW-CRITICAL.",
        },
    )
    gate = _step(cp, "carren", {"gap": False, "confidence": "CERTAIN"})
    planning = _step(cp, "user", {"trusted_human_event": _event(gate["questions"][0])})
    assert planning["state_id"] == "planning"
    assert "ANNIE-NEW-CRITICAL" in planning["task_summary"]

    recovered_registry = ArtifactRegistry(Checkpointer(db_path=database), "run")
    selected = recovered_registry.selected("annie_findings")
    assert selected is not None
    assert recovered_registry.get(selected).payload["findings"] == [high]
