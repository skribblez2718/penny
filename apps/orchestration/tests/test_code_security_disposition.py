"""Finding state, independent review, and human-only residual-risk contracts."""

from datetime import datetime, timezone

from orchestration.code_artifacts import validate_finding_dispositions
from orchestration.execution_receipts import validate_independent_disposition


def _acceptance(**overrides):
    value = {
        "finding_id": "ANNIE-H1",
        "scope": "receipt signer isolation",
        "rationale": "accepted for the isolated local fixture",
        "accepter": "human:operator",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "run_id": "run-1",
        "authorization_ref": "trusted-risk-acceptance-artifact",
    }
    value.update(overrides)
    return value


def test_residual_risk_requires_complete_human_acceptance_and_survives_terminal():
    acceptance = _acceptance()
    finding = {
        "id": "ANNIE-H1",
        "state": "human_accepted_residual_risk",
        "evidence_class": "judgment-only",
        "acceptance": acceptance,
    }
    assert validate_finding_dispositions([finding], run_id="run-1") == []
    # The accepted object is retained whole for terminal result/outcome copying.
    terminal = {"met": True, "residual_risks": [finding["acceptance"]]}
    assert terminal["residual_risks"][0] == acceptance

    for missing in (
        "finding_id",
        "scope",
        "rationale",
        "accepter",
        "timestamp",
        "authorization_ref",
    ):
        incomplete = _acceptance()
        incomplete.pop(missing)
        invalid = {**finding, "acceptance": incomplete}
        assert validate_finding_dispositions([invalid], run_id="run-1")


def test_unresolved_duplicate_or_unsupported_finding_blocks_completion():
    unresolved = {"id": "A", "state": "unresolved", "evidence_class": "judgment-only"}
    assert any(
        "unresolved" in error for error in validate_finding_dispositions([unresolved], run_id="r")
    )
    duplicate = [
        {
            "id": "A",
            "state": "remediated",
            "evidence_class": "command-verifiable",
            "evidence_refs": ["receipt"],
        },
        {
            "id": "A",
            "state": "not_applicable",
            "evidence_class": "judgment-only",
            "rationale": "duplicate",
        },
    ]
    assert any(
        "more than one state" in error
        for error in validate_finding_dispositions(duplicate, run_id="r")
    )


def test_judgment_disposition_enforces_actor_and_model_independence():
    disposition = {
        "schema_version": 1,
        "run_id": "run-1",
        "obligation_id": "quality:unnecessary_complexity_avoidance",
        "finding_id": None,
        "evidence_refs": ["implementation-1"],
        "rationale": "Independent review found no unnecessary branch or abstraction.",
        "final_disposition": "satisfied",
        "reviewer_identity": "reviewer:carren",
        "reviewer_model": "provider/reviewer-model",
        "evidence_author_identity": "author:skribble",
        "evidence_author_model": "provider/author-model",
        "execution_actor_identity": "executor:bash",
        "execution_actor_model": "provider/executor-model",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "redaction_state": "redacted",
    }
    assert validate_independent_disposition(
        disposition,
        run_id="run-1",
        obligation_id="quality:unnecessary_complexity_avoidance",
    ) == (True, "")

    disposition["reviewer_identity"] = "author:skribble"
    assert (
        validate_independent_disposition(
            disposition,
            run_id="run-1",
            obligation_id="quality:unnecessary_complexity_avoidance",
        )[0]
        is False
    )
