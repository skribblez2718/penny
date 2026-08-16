from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from memory.build_disposition import build_disposition
from memory.canary_cutover import CanaryCutoverController, load_cutover_state
from memory.common import ValidationError, sha256_file
from memory.cutover_config import CutoverConfig
from memory.cutover_evidence import (
    EvidenceArtifact,
    EvidenceBundle,
    consume_one_time_approval,
    validate_transition_bundle,
)
from memory.reconcile_manifest import reconcile_manifests
from memory.tests.fake_hub import FakeHub
from memory.tests.test_cutover_faults import _write_json, build_cutover_config
from memory.tests.test_manifests import _export
from memory.verify_disposition import verify_disposition

APPROVED_AT = "2026-08-15T12:00:00Z"


def _release_gate(path: Path, config: CutoverConfig, gate: str) -> Path:
    return _write_json(
        path,
        {
            "schema_version": 1,
            "receipt_type": "memory-release-gate",
            "cutover_id": config.cutover_id,
            "gate": gate,
            "status": "PASS",
            "source_config_sha256": config.source.config_sha256,
            "candidate_config_sha256": config.candidate.config_sha256,
            "approved": True,
            "approved_by": "synthetic-owner",
            "approved_at": APPROVED_AT,
        },
    )


def _operator_approval(
    path: Path, config: CutoverConfig, scope: str, subjects: dict[str, str]
) -> Path:
    return _write_json(
        path,
        {
            "schema_version": 1,
            "receipt_type": "memory-operator-approval",
            "approval_id": f"approval-{scope}",
            "cutover_id": config.cutover_id,
            "config_sha256": config.config_sha256,
            "scope": scope,
            "decision": "APPROVE",
            "subjects": [{"name": name, "sha256": digest} for name, digest in subjects.items()],
            "approved_by": "synthetic-owner",
            "approved_at": APPROVED_AT,
        },
    )


def _qualification_bundle(root: Path, config: CutoverConfig) -> Path:
    source_export = _export(root / "source-copy", source_id="source-copy")
    candidate_export = _export(root / "candidate-copy", source_id="candidate-copy")
    data_reconciliation = root / "data-reconciliation.json"
    reconcile_manifests(
        source_export / "manifest.json",
        candidate_export / "manifest.json",
        source_export / "copy-receipt.json",
        candidate_export / "copy-receipt.json",
        data_reconciliation,
    )
    source_manifest = json.loads((source_export / "manifest.json").read_text(encoding="utf-8"))
    disposition_hashes = {
        (record["record_class"], record["record_id"]): record["logical_hash"]
        for record in source_manifest["logical_records"]
    }
    decisions = []
    for record_class, record_id in (("drawer", "drawer-1"), ("kg", "triple-1")):
        decisions.append(
            {
                "record_class": record_class,
                "record_id": record_id,
                "source_hash": disposition_hashes[(record_class, record_id)],
                "status": "hot",
                "reason": "Synthetic operator-reviewed fixture",
                "destination": "candidate/hot",
                "reviewer": "synthetic-owner",
                "policy": "synthetic-policy/v1",
                "reversible": True,
                "reversibility_basis": "Immutable source export remains readable",
                "approved": True,
            }
        )
    decisions_path = _write_json(
        root / "decisions.json",
        {
            "schema_version": 1,
            "document_type": "memory-disposition-decisions",
            "decisions": decisions,
        },
    )
    disposition_path = root / "disposition.json"
    build_disposition(
        source_export / "manifest.json",
        disposition_path,
        source_export / "copy-receipt.json",
        decisions_path,
    )
    disposition_verification = root / "disposition-verification.json"
    verify_disposition(
        source_export / "manifest.json",
        disposition_path,
        source_export / "copy-receipt.json",
        disposition_verification,
        require_approved=True,
    )
    source_authority = _write_json(
        root / "source-authority.json",
        {
            "schema_version": 1,
            "receipt_type": "memory-authority-approval",
            "cutover_id": config.cutover_id,
            "authority_role": "source",
            "palace_id": config.source.palace_id,
            "hub_config_sha256": config.source.config_sha256,
            "sole_writer": True,
            "no_fallback": True,
            "approved": True,
            "approved_by": "synthetic-owner",
            "approved_at": APPROVED_AT,
        },
    )
    shadow = _write_json(
        root / "shadow.json",
        {
            "schema_version": 1,
            "receipt_type": "memory-shadow-comparison",
            "cutover_id": config.cutover_id,
            "cutover_config_sha256": config.config_sha256,
            "source_config_sha256": config.source.config_sha256,
            "candidate_config_sha256": config.candidate.config_sha256,
            "source_sole_writer": True,
            "candidate_write_count": 0,
            "passed": True,
            "mismatch_count": 0,
            "source_authority_receipt_sha256": sha256_file(source_authority),
        },
    )
    fault_gate = _write_json(
        root / "fault-gate.json",
        {
            "schema_version": 1,
            "receipt_type": "memory-fault-gate",
            "cutover_id": config.cutover_id,
            "config_sha256": config.config_sha256,
            "status": "PASS",
            "tests": {
                "ambiguous_timeout": True,
                "kill_object_before_journal_ack": True,
                "duplicate_operation": True,
                "replay_idempotency": True,
                "mismatch_no_go": True,
            },
            "approved": True,
            "approved_by": "synthetic-owner",
            "approved_at": APPROVED_AT,
        },
    )
    artifacts: dict[str, Path] = {
        "gate-a": _release_gate(root / "gate-a.json", config, "GATE-A"),
        "gate-b1": _release_gate(root / "gate-b1.json", config, "GATE-B1"),
        "data-gate": _release_gate(root / "data-gate.json", config, "DATA-03"),
        "source-authority": source_authority,
        "initial-drain": root / "source-copy" / "drain.json",
        "source-export-manifest": source_export / "manifest.json",
        "source-copy-receipt": source_export / "copy-receipt.json",
        "data-candidate-manifest": candidate_export / "manifest.json",
        "data-candidate-copy": candidate_export / "copy-receipt.json",
        "data-reconciliation": data_reconciliation,
        "disposition-verification": disposition_verification,
        "shadow-receipt": shadow,
        "fault-gate": fault_gate,
    }
    artifacts["source-export-approval"] = _operator_approval(
        root / "source-export-approval.json",
        config,
        "source-export",
        {
            "manifest": sha256_file(artifacts["source-export-manifest"]),
            "copy-receipt": sha256_file(artifacts["source-copy-receipt"]),
            "drain-receipt": sha256_file(artifacts["initial-drain"]),
        },
    )
    artifacts["data-approval"] = _operator_approval(
        root / "data-approval.json",
        config,
        "data-reconciliation",
        {
            "candidate-manifest": sha256_file(artifacts["data-candidate-manifest"]),
            "candidate-copy": sha256_file(artifacts["data-candidate-copy"]),
            "reconciliation": sha256_file(data_reconciliation),
        },
    )
    artifacts["disposition-approval"] = _operator_approval(
        root / "disposition-approval.json",
        config,
        "disposition",
        {"verification": sha256_file(disposition_verification)},
    )
    artifacts["shadow-approval"] = _operator_approval(
        root / "shadow-approval.json",
        config,
        "shadow-comparison",
        {"shadow-receipt": sha256_file(shadow)},
    )
    return _write_json(
        root / "qualification-bundle.json",
        {
            "schema_version": 1,
            "bundle_type": "memory-cutover-evidence",
            "cutover_id": config.cutover_id,
            "config_sha256": config.config_sha256,
            "stage": "qualification",
            "artifacts": [
                {"name": name, "path": str(path), "sha256": sha256_file(path)}
                for name, path in artifacts.items()
            ],
            "claims": {
                "source_sole_writer": True,
                "candidate_writes": False,
                "live_peak_cycle": "NOT RUN",
                "maintenance_cycle": "NOT RUN",
            },
        },
    )


def test_qualification_apply_requires_all_receipts_and_burns_capability_once(
    tmp_path: Path,
) -> None:
    with FakeHub() as source, FakeHub() as candidate:
        config = build_cutover_config(tmp_path, source, candidate)
        bundle = _qualification_bundle(tmp_path / "evidence", config)
        preview = CanaryCutoverController(config).dry_run("qualify", bundle)
        approval = _write_json(
            tmp_path / "qualify-approval.json",
            {
                "schema_version": 1,
                "receipt_type": "memory-one-time-approval",
                "capability_id": "qualify-capability",
                "nonce": "synthetic-nonce",
                "cutover_id": config.cutover_id,
                "config_sha256": config.config_sha256,
                "action": "qualify",
                "evidence_sha256": sha256_file(bundle),
                "approved_by": "synthetic-owner",
                "approved_at": APPROVED_AT,
                "expires_at": "2099-01-01T00:00:00Z",
            },
        )
        consumption = tmp_path / "qualify-consumption.json"
        state = CanaryCutoverController(config).apply("qualify", bundle, approval, consumption)

        assert preview["would_mutate"] is False
        assert state.state == "qualified"
        assert state.authority_role == "source"
        assert state.admitted_client_ids == config.approved_client_ids
        assert state.fault_gate_passed is True
        assert load_cutover_state(config) == state
        assert stat.S_IMODE(config.approval_ledger_path.stat().st_mode) == 0o600
        assert source.state.write_calls == 0
        assert candidate.state.write_calls == 0

        with pytest.raises(ValidationError, match="already been consumed"):
            consume_one_time_approval(
                approval,
                tmp_path / "second-consumption.json",
                config,
                action="qualify",
                evidence_sha256=sha256_file(bundle),
            )


def test_expansion_refuses_not_run_peak_and_maintenance_cycles(tmp_path: Path) -> None:
    with FakeHub() as source, FakeHub() as candidate:
        config = build_cutover_config(tmp_path, source, candidate)
        journal = _write_json(tmp_path / "journal-placeholder.json", {"fixture": True})
        journal_digest = sha256_file(journal)
        reconciliation = _write_json(
            tmp_path / "accepted-reconciliation.json",
            {
                "schema_version": 1,
                "receipt_type": "memory-accepted-write-reconciliation",
                "target_role": "candidate",
                "journal_sha256": journal_digest,
                "operation_count": 0,
                "accepted_count": 0,
                "reconciled_count": 0,
                "exact": True,
                "pending_count": 0,
                "mismatches": [],
            },
        )
        cycles = _write_json(
            tmp_path / "cycles.json",
            {
                "schema_version": 1,
                "document_type": "memory-canary-cycle-evidence",
                "cutover_id": config.cutover_id,
                "config_sha256": config.config_sha256,
                "live_peak_cycle": {
                    "status": "NOT RUN",
                    "started_at": None,
                    "completed_at": None,
                    "evidence_sha256": None,
                    "approved_by": None,
                },
                "diary_retention_maintenance_cycle": {
                    "status": "NOT RUN",
                    "started_at": None,
                    "completed_at": None,
                    "evidence_sha256": None,
                    "approved_by": None,
                },
                "production_expansion_authorized": False,
            },
        )
        bundle = EvidenceBundle(
            path=tmp_path / "bundle.json",
            sha256="0" * 64,
            cutover_id=config.cutover_id,
            config_sha256=config.config_sha256,
            stage="expand",
            artifacts={
                "accepted-write-reconciliation": EvidenceArtifact(
                    "accepted-write-reconciliation",
                    reconciliation,
                    sha256_file(reconciliation),
                ),
                "cycle-evidence": EvidenceArtifact("cycle-evidence", cycles, sha256_file(cycles)),
            },
            claims={
                "accepted_write_count": 0,
                "exact": True,
                "pending_count": 0,
                "live_peak_cycle": "PASS",
                "maintenance_cycle": "PASS",
            },
        )

        with pytest.raises(ValidationError, match="does not authorize expansion"):
            validate_transition_bundle(
                bundle,
                config,
                journal_sha256=journal_digest,
                accepted_write_count=0,
            )
