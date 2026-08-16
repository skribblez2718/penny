"""Execution-owner protocol-v2 builders for orchestration tests."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from orchestration.artifact_cli import put_output_artifact
from orchestration.artifacts import OutputArtifactMetadata, canonical_json
from orchestration.execution_receipts import build_receipt, sign_receipt

TEST_RECEIPT_KEY_HEX = "5a" * 32


def _receipt_id(metadata: OutputArtifactMetadata) -> str:
    identity = {
        "branch_id": metadata.branch_id,
        "kind": metadata.kind,
        "operation_id": metadata.operation_id,
        "phase": metadata.phase,
        "run_id": metadata.run_id,
        "version": metadata.version,
    }
    return f"artifact-receipt:{hashlib.sha256(canonical_json(identity)).hexdigest()}"


def owner_result(
    directive: dict[str, Any],
    summary: dict[str, Any],
    *,
    branch_id: str | None = None,
    exit_code: int = 0,
    summary_missing: bool = False,
    error: str | None = None,
    output: str | None = None,
) -> dict[str, Any]:
    """Persist exact output and return the driver's exact single/branch wrapper."""
    if branch_id is None:
        agent = str(directive["agent"])
        metadata_value = directive["output_artifact"]
    else:
        task = next(task for task in directive["tasks"] if task["branch_id"] == branch_id)
        agent = str(task["agent"])
        metadata_value = task["output_artifact"]
    metadata = OutputArtifactMetadata.from_dict(metadata_value)
    if output is None:
        output = (
            "agent emitted no machine summary"
            if summary_missing
            else "owner-captured output\nSUMMARY:"
            + json.dumps(summary, ensure_ascii=False, separators=(",", ":"))
        )
    ref = put_output_artifact(metadata, output.encode("utf-8"))

    now = datetime.now(timezone.utc).isoformat()
    receipt_id = _receipt_id(metadata)
    key = bytes.fromhex(TEST_RECEIPT_KEY_HEX)
    receipt = build_receipt(
        receipt_id=receipt_id,
        run_id=metadata.run_id,
        state_id=metadata.phase,
        obligation_id=f"state:{metadata.phase}",
        argv=["pi-agent", "--agent", agent],
        working_directory=str(Path(directive.get("project_root") or Path.cwd()).resolve()),
        executor_identity=f"agent:{agent}",
        execution_owner_identity="skill-extension-execution-owner",
        started_at=now,
        ended_at=now,
        exit_status=exit_code,
        output_artifact_ref=canonical_json(ref.to_dict()).decode("utf-8"),
        output=output,
        key=key,
    )
    invocation: dict[str, Any] = {
        "schema_version": 1,
        "invocation_id": receipt_id,
        "run_id": metadata.run_id,
        "state_id": metadata.phase,
        "agent_identity": f"agent:{agent}",
        "model": "test/provider-model",
        "execution_owner_identity": "skill-extension-execution-owner",
        "started_at": now,
        "ended_at": now,
        "signature_algorithm": "hmac-sha256",
        "signature": "",
    }
    invocation["signature"] = sign_receipt(invocation, key)
    result: dict[str, Any] = {
        "protocol_version": 2,
        "run_id": ref.run_id,
        "phase": ref.phase,
        "branch_id": ref.branch_id,
        "producer": ref.producer,
        "operation_id": ref.operation_id,
        "output_artifact_ref": ref.to_dict(),
        "execution_receipt": receipt,
        "exitCode": exit_code,
        "summary": summary,
        "summary_missing": summary_missing,
        "receipts": [receipt],
        "trusted_invocation": invocation,
    }
    if branch_id is not None:
        result["agent"] = agent
    if error is not None:
        result["error"] = error
    elif exit_code or summary_missing:
        result["error"] = "agent execution failed" if exit_code else "no parseable SUMMARY"
    return result
