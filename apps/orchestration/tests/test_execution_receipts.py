"""Execution-owner receipt authenticity, binding, integrity, and redaction tests."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone

import pytest

from orchestration.execution_receipts import (
    build_receipt,
    redact_sensitive_output,
    validate_execution_receipt,
)


@pytest.fixture
def key():
    return bytes.fromhex("11" * 32)


def _receipt(tmp_path, key, **overrides):
    started = datetime.now(timezone.utc)
    values = {
        "receipt_id": "receipt-1",
        "run_id": "run-1",
        "state_id": "verifying",
        "obligation_id": "criterion:1",
        "argv": ["pytest", "tests", "-q"],
        "working_directory": str(tmp_path),
        "executor_identity": "tool:bash",
        "execution_owner_identity": "skill-driver",
        "started_at": started.isoformat(),
        "ended_at": (started + timedelta(seconds=1)).isoformat(),
        "exit_status": 0,
        "output_artifact_ref": "driver://run-1/output-1",
        "output": "12 passed\nAPI_TOKEN=raw-secret-value",
        "key": key,
        "secret_values": ["raw-secret-value"],
    }
    values.update(overrides)
    return build_receipt(**values)


def test_valid_same_run_receipt_preserves_status_and_redacted_digest(tmp_path, key):
    receipt = _receipt(
        tmp_path,
        key,
        output="12 passed --password hidden-value TOKEN=other-value",
        secret_values=["hidden-value", "other-value"],
    )
    assert "hidden-value" not in receipt["output_excerpt"]
    assert "other-value" not in receipt["output_excerpt"]
    assert "[REDACTED]" in receipt["output_excerpt"]
    assert validate_execution_receipt(
        receipt,
        run_id="run-1",
        obligation_id="criterion:1",
        key=key,
        allowed_working_root=str(tmp_path),
    ) == (True, "")


@pytest.mark.parametrize(
    ("mutation", "reason"),
    [
        (lambda value: value.update(run_id="other-run"), "different run"),
        (lambda value: value.update(obligation_id="criterion:2"), "different obligation"),
        (lambda value: value.update(exit_status=1), "not successful"),
        (lambda value: value.update(state_id="implementing"), "final verifying state"),
        (
            lambda value: value.update(execution_owner_identity=value["executor_identity"]),
            "must be distinct",
        ),
        (lambda value: value.update(working_directory="relative/path"), "canonical and absolute"),
        (lambda value: value.update(output_excerpt="tampered"), "digest is tampered"),
        (lambda value: value.update(integrity_state="unknown"), "not intact"),
        (lambda value: value.update(redaction_state="raw"), "not valid"),
    ],
)
def test_forged_wrong_run_tampered_failed_and_wrong_class_receipts_rejected(
    tmp_path, key, mutation, reason
):
    receipt = _receipt(tmp_path, key)
    mutation(receipt)
    valid, error = validate_execution_receipt(
        receipt,
        run_id="run-1",
        obligation_id="criterion:1",
        key=key,
        allowed_working_root=str(tmp_path),
    )
    assert not valid
    assert reason in error


def test_signature_forgery_and_missing_owner_key_never_satisfy(tmp_path, key):
    receipt = _receipt(tmp_path, key)
    forged = deepcopy(receipt)
    forged["signature"] = "0" * 64
    assert (
        validate_execution_receipt(forged, run_id="run-1", obligation_id="criterion:1", key=key)[0]
        is False
    )
    assert (
        validate_execution_receipt(receipt, run_id="run-1", obligation_id="criterion:1", key=None)[
            0
        ]
        is False
    )


def test_redaction_covers_short_flags_inline_assignments_bearer_and_terminal_controls():
    output = "--token abcdef TOKEN=ghijkl password:mnopqr " "Authorization: Bearer qrstuv\x1b"
    redacted = redact_sensitive_output(output)
    for secret in ("abcdef", "ghijkl", "mnopqr", "qrstuv"):
        assert secret not in redacted
    assert "\\u001b" in redacted
