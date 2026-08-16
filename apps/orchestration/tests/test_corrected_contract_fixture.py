"""Language-neutral corrected Python oracle consumed by the TypeScript parity suite."""

from __future__ import annotations

import json
from pathlib import Path

from orchestration.contracts import Confidence, weakest_confidence

_FIXTURE = Path(__file__).parent / "fixtures" / "corrected-python-contract-v1.json"


def _fixture() -> dict:
    return json.loads(_FIXTURE.read_text(encoding="utf-8"))


def test_corrected_fixture_has_unique_case_ids_and_canonical_actions():
    fixture = _fixture()
    ids = [case["id"] for case in fixture["identity"]["cases"]]
    ids.extend(case["id"] for case in fixture["terminal_truth"])
    assert len(ids) == len(set(ids))
    assert {case["action"] for case in fixture["terminal_truth"]} == {
        "complete",
        "incomplete",
    }


def test_corrected_fixture_confidence_matches_the_runtime_contract():
    confidence = _fixture()["confidence"]
    assert set(confidence["valid"]) == Confidence.ALL
    assert all(not Confidence.is_valid(value) for value in confidence["invalid"])
    assert weakest_confidence(["CERTAIN", "invented"]) == confidence["invalid_fan_aggregate"]


def test_corrected_fixture_freezes_privacy_and_recovery_boundaries():
    fixture = _fixture()
    assert "telemetry.goal" in fixture["privacy"]["forbidden_raw_fields"]
    assert "public_result.query" in fixture["privacy"]["forbidden_raw_fields"]
    assert fixture["recovery"] == {
        "exact_operation": "recover",
        "scan_operation": "recover_pending",
        "unknown_playbook": "PLAYBOOK_UNAVAILABLE",
        "unknown_playbook_mutates_checkpoint": False,
    }
