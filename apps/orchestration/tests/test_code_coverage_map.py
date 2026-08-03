"""100% typed obligation coverage rejects strings, wrong classes, and gaps."""

from datetime import datetime, timedelta, timezone

from orchestration.code_artifacts import (
    QUALITY_DIMENSION_IDS,
    expected_obligation_ids,
    validate_coverage_map,
)
from orchestration.playbooks.code import _bind_trusted_evidence_to_coverage
from orchestration.execution_receipts import (
    build_receipt,
    validate_execution_receipt,
    validate_independent_disposition,
)

KEY = bytes.fromhex("22" * 32)
RUN = "coverage-run"


def _receipt(tmp_path, obligation_id):
    started = datetime.now(timezone.utc)
    return build_receipt(
        receipt_id=f"receipt:{obligation_id}",
        run_id=RUN,
        state_id="verifying",
        obligation_id=obligation_id,
        argv=["check", obligation_id],
        working_directory=str(tmp_path),
        executor_identity="executor:bash",
        execution_owner_identity="owner:skill-driver",
        started_at=started.isoformat(),
        ended_at=(started + timedelta(milliseconds=1)).isoformat(),
        exit_status=0,
        output_artifact_ref=f"driver://{obligation_id}",
        output=f"PASS {obligation_id}",
        key=KEY,
    )


def _disposition(obligation_id):
    return {
        "schema_version": 1,
        "run_id": RUN,
        "obligation_id": obligation_id,
        "finding_id": None,
        "evidence_refs": ["implementation"],
        "rationale": "Independent source review applied the selected canonical definition.",
        "final_disposition": "satisfied",
        "reviewer_identity": "reviewer:carren",
        "reviewer_model": "provider/reviewer",
        "evidence_author_identity": "author:skribble",
        "evidence_author_model": "provider/author",
        "execution_actor_identity": "actor:bash",
        "execution_actor_model": "provider/actor",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "redaction_state": "redacted",
    }


def _complete_map(tmp_path):
    expected = expected_obligation_ids(1, [])
    evidence = {}
    obligations = []
    judgment_ids = {
        "quality:harmful_duplication_avoidance",
        "quality:unnecessary_complexity_avoidance",
    }
    for obligation_id in sorted(expected):
        if obligation_id in judgment_ids:
            evidence_id = f"disposition:{obligation_id}"
            evidence[evidence_id] = ("security_disposition", _disposition(obligation_id))
            evidence_class = "judgment-only"
        else:
            evidence_id = f"receipt:{obligation_id}"
            evidence[evidence_id] = ("execution_receipt", _receipt(tmp_path, obligation_id))
            evidence_class = "command-verifiable"
        obligations.append(
            {
                "id": obligation_id,
                "evidence_class": evidence_class,
                "status": "satisfied",
                "evidence_refs": [evidence_id],
            }
        )
    return (
        {
            "schema_version": 1,
            "run_id": RUN,
            "obligations": obligations,
            "selected_refs": {},
        },
        expected,
        evidence,
    )


def _validate(value, expected, evidence, tmp_path):
    return validate_coverage_map(
        value,
        run_id=RUN,
        expected_ids=expected,
        evidence_resolver=lambda evidence_id: evidence.get(evidence_id),
        receipt_validator=lambda payload, obligation: validate_execution_receipt(
            payload,
            run_id=RUN,
            obligation_id=obligation,
            key=KEY,
            allowed_working_root=str(tmp_path),
        ),
        independence_validator=lambda payload, obligation: validate_independent_disposition(
            payload, run_id=RUN, obligation_id=obligation
        ),
    )


def test_complete_coverage_accepts_all_criteria_and_exactly_six_dimensions(tmp_path):
    coverage, expected, evidence = _complete_map(tmp_path)
    assert {item["id"] for item in coverage["obligations"]} == {
        "criterion:1",
        *(f"quality:{dimension}" for dimension in QUALITY_DIMENSION_IDS),
    }
    assert _validate(coverage, expected, evidence, tmp_path) == []


def test_agent_evidence_alone_and_incomplete_coverage_cannot_set_met(tmp_path):
    coverage, expected, evidence = _complete_map(tmp_path)
    removed = coverage["obligations"].pop()
    errors = _validate(coverage, expected, evidence, tmp_path)
    assert any("incomplete" in error and removed["id"] in error for error in errors)

    coverage, expected, evidence = _complete_map(tmp_path)
    coverage["obligations"][0]["evidence_refs"] = ["self-authored evidence: tests passed"]
    assert any(
        "missing evidence" in error for error in _validate(coverage, expected, evidence, tmp_path)
    )


def test_owner_binding_replaces_all_self_authored_evidence_by_evidence_class():
    value = {
        "obligations": [
            {
                "id": "criterion:1",
                "evidence_class": "command-verifiable",
                "evidence_refs": ["agent says pass"],
            },
            {
                "id": "quality:target_idiom",
                "evidence_class": "judgment-only",
                "evidence_refs": ["disposition-1"],
            },
        ]
    }
    bound = _bind_trusted_evidence_to_coverage(
        value,
        {"criterion:1": "receipt-artifact-1"},
        {"quality:target_idiom": "disposition-artifact-1"},
    )
    assert bound["obligations"][0]["evidence_refs"] == ["receipt-artifact-1"]
    assert bound["obligations"][1]["evidence_refs"] == ["disposition-artifact-1"]
    assert value["obligations"][0]["evidence_refs"] == ["agent says pass"]


def test_coverage_cannot_reclassify_a_selected_judgment_obligation_as_command(tmp_path):
    coverage, expected, evidence = _complete_map(tmp_path)
    judgment_id = "quality:harmful_duplication_avoidance"
    judgment = next(item for item in coverage["obligations"] if item["id"] == judgment_id)
    receipt_id = f"receipt:{judgment_id}"
    evidence[receipt_id] = ("execution_receipt", _receipt(tmp_path, judgment_id))
    judgment["evidence_class"] = "command-verifiable"
    judgment["evidence_refs"] = [receipt_id]
    errors = validate_coverage_map(
        coverage,
        run_id=RUN,
        expected_ids=expected,
        evidence_resolver=lambda evidence_id: evidence.get(evidence_id),
        receipt_validator=lambda payload, obligation: validate_execution_receipt(
            payload,
            run_id=RUN,
            obligation_id=obligation,
            key=KEY,
            allowed_working_root=str(tmp_path),
        ),
        independence_validator=lambda payload, obligation: validate_independent_disposition(
            payload, run_id=RUN, obligation_id=obligation
        ),
        evidence_class_resolver=lambda obligation: (
            "judgment-only" if obligation == judgment_id else "command-verifiable"
        ),
    )
    assert any("differs from selected class" in error for error in errors)


def test_command_obligation_rejects_judgment_disposition_and_failed_receipt(tmp_path):
    coverage, expected, evidence = _complete_map(tmp_path)
    command = next(
        item for item in coverage["obligations"] if item["evidence_class"] == "command-verifiable"
    )
    evidence_id = command["evidence_refs"][0]
    evidence[evidence_id] = ("security_disposition", _disposition(command["id"]))
    assert any(
        "wrong evidence class" in error
        for error in _validate(coverage, expected, evidence, tmp_path)
    )

    coverage, expected, evidence = _complete_map(tmp_path)
    command = next(
        item for item in coverage["obligations"] if item["evidence_class"] == "command-verifiable"
    )
    evidence[command["evidence_refs"][0]][1]["exit_status"] = 1
    assert any(
        "not successful" in error for error in _validate(coverage, expected, evidence, tmp_path)
    )
