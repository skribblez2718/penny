"""Representative pre-P0 pending checkpoints resume without fabricated proof."""

import pytest

from orchestration.checkpointer import STATUS_AWAITING_USER, STATUS_RUNNING, Checkpointer
from orchestration.context import RunContext
from orchestration.recovery import recover_pending

IDEAL = {
    "goal": "legacy recovery",
    "source": "legacy-fixture",
    "schema_version": 2,
    "language": "Go",
    "success_criteria": ["resume exactly"],
    "deliverables": ["cmd/"],
    "verification": {"unit_tests": True},
}
PROFILE = {
    "schema_version": 1,
    "status": "selected",
    "languages": ["Go"],
    "framework_runtime": ["framework-free"],
    "target_scope": ["cmd/"],
    "tooling": {
        "package": ["go"],
        "build": ["go build ./..."],
        "test": ["go test ./..."],
        "lint": ["go vet ./..."],
        "type": [],
    },
    "verification_commands": ["go test ./..."],
    "conventions": [{"name": "format", "value": "gofmt", "source_evidence": "go.mod"}],
    "confidence": "CERTAIN",
    "source_evidence": ["go.mod", "legacy durable caller profile"],
    "unverified_reasons": [],
}


@pytest.mark.parametrize(
    ("state", "status"),
    [
        ("exploring", STATUS_RUNNING),
        ("criteria_gate", STATUS_AWAITING_USER),
        ("implementing", STATUS_RUNNING),
        ("verifying", STATUS_RUNNING),
        ("learning", STATUS_RUNNING),
    ],
)
def test_five_legacy_pending_stages_resume_without_fabricated_p0_proof(tmp_path, state, status):
    cp = Checkpointer(db_path=tmp_path / f"{state}.db")
    context = RunContext(
        session_id=f"session-{state}",
        run_id=f"run-{state}",
        playbook="code",
        project_root=str(tmp_path),
        goal=IDEAL["goal"],
        constraints={"ideal_state": IDEAL, "target_profile": PROFILE},
    )
    context.success_criteria = list(IDEAL["success_criteria"])
    context.iteration_history = [
        {"iteration": 0, "strategy_change": "", "gaps": ["legacy gap"], "confidence": ""}
    ]
    context.extras["preexisting_ref"] = "artifact-before-p0"
    context.extras["code"] = {
        "ideal_state": IDEAL,
        "language": "Go",
        "criteria_issues": {},
        "criteria_findings": [],
    }
    cp.save(
        run_id=context.run_id,
        session_id=context.session_id,
        playbook="code",
        current_state_id=state,
        context=context,
        status=status,
    )

    directives = recover_pending(cp, session_id=context.session_id, playbook="code")
    assert len(directives) == 1
    directive = directives[0]
    assert directive["run_id"] == context.run_id
    assert directive.get("state_id", directive.get("previous_state")) == state

    recovered = cp.load(context.run_id).context
    assert recovered.session_id == context.session_id
    assert recovered.run_id == context.run_id
    assert recovered.iteration_history == context.iteration_history
    assert recovered.extras["preexisting_ref"] == "artifact-before-p0"
    p0 = recovered.extras["code"]["p0_migration"]
    assert p0["status"] == "unverified"
    assert "provenance" in p0
