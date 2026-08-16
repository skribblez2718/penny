"""Hash-bound operator evidence and one-time cutover capabilities."""

from __future__ import annotations

import fcntl
import json
import os
import stat
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, cast

from .common import (
    ValidationError,
    atomic_write_json,
    canonical_json_bytes,
    ensure_owner_only,
    load_json_object,
    require_absolute_path,
    require_identifier,
    require_sha256,
    require_utc_timestamp,
    sha256_file,
    utc_now,
)
from .cutover_config import CutoverConfig
from .manifest_core import validate_copy_receipt, validate_drain_receipt, validate_export_manifest

EVIDENCE_SCHEMA_VERSION = 1
RELEASE_GATE_RECEIPT = "memory-release-gate"
AUTHORITY_RECEIPT = "memory-authority-approval"
FAULT_GATE_RECEIPT = "memory-fault-gate"
OPERATOR_APPROVAL_RECEIPT = "memory-operator-approval"
ONE_TIME_APPROVAL_RECEIPT = "memory-one-time-approval"
APPROVAL_CONSUMPTION_RECEIPT = "memory-approval-consumption"
EVIDENCE_BUNDLE_TYPE = "memory-cutover-evidence"
SHADOW_RECEIPT_TYPE = "memory-shadow-comparison"
ACCEPTED_RECONCILIATION_TYPE = "memory-accepted-write-reconciliation"
REPLAY_RECEIPT_TYPE = "memory-exact-replay"
LOGICAL_RECONCILIATION_TYPE = "memory-logical-reconciliation"
DISPOSITION_VERIFICATION_TYPE = "memory-disposition-verification"
CANARY_CYCLE_EVIDENCE_TYPE = "memory-canary-cycle-evidence"
APPROVAL_LEDGER_TYPE = "memory-approval-ledger"
APPROVAL_LEDGER_MODE = 0o600
MAX_APPROVAL_LEDGER_BYTES = 16 * 1024 * 1024
REQUIRED_FAULT_TESTS = frozenset(
    {
        "ambiguous_timeout",
        "kill_object_before_journal_ack",
        "duplicate_operation",
        "replay_idempotency",
        "mismatch_no_go",
    }
)


@dataclass(frozen=True)
class EvidenceArtifact:
    """One verified absolute evidence path from a private runtime bundle."""

    name: str
    path: Path
    sha256: str


@dataclass(frozen=True)
class EvidenceBundle:
    """Strict stage-specific collection of hash-bound evidence files."""

    path: Path
    sha256: str
    cutover_id: str
    config_sha256: str
    stage: str
    artifacts: dict[str, EvidenceArtifact]
    claims: dict[str, Any]


def _require_version(document: Mapping[str, Any], field: str) -> None:
    if document.get("schema_version") != EVIDENCE_SCHEMA_VERSION:
        raise ValidationError(f"{field} schema_version must be {EVIDENCE_SCHEMA_VERSION}")


def _load_receipt(path: Path, expected_type: str) -> dict[str, Any]:
    ensure_owner_only(path, expected_type)
    document = load_json_object(path)
    _require_version(document, expected_type)
    if document.get("receipt_type") != expected_type:
        raise ValidationError(f"receipt_type must be {expected_type}: {path}")
    return document


def validate_release_gate(path: Path, config: CutoverConfig, gate: str) -> dict[str, Any]:
    """Require an owner-approved PASS for one named release/data gate."""

    document = _load_receipt(path, RELEASE_GATE_RECEIPT)
    required = {
        "schema_version",
        "receipt_type",
        "cutover_id",
        "gate",
        "status",
        "source_config_sha256",
        "candidate_config_sha256",
        "approved",
        "approved_by",
        "approved_at",
    }
    if set(document) != required:
        raise ValidationError(f"{gate} receipt has unknown or missing fields")
    if (
        document.get("cutover_id") != config.cutover_id
        or document.get("gate") != gate
        or document.get("status") != "PASS"
        or document.get("approved") is not True
    ):
        raise ValidationError(f"{gate} has not passed with operator approval")
    if document.get("source_config_sha256") != config.source.config_sha256:
        raise ValidationError(f"{gate} source config hash mismatch")
    if document.get("candidate_config_sha256") != config.candidate.config_sha256:
        raise ValidationError(f"{gate} candidate config hash mismatch")
    require_identifier(document.get("approved_by"), f"{gate}.approved_by")
    require_utc_timestamp(document.get("approved_at"), f"{gate}.approved_at")
    return document


def validate_authority_receipt(
    path: Path, config: CutoverConfig, authority_role: str
) -> dict[str, Any]:
    """Require an approved sole-writer authority with fallback disabled."""

    document = _load_receipt(path, AUTHORITY_RECEIPT)
    required = {
        "schema_version",
        "receipt_type",
        "cutover_id",
        "authority_role",
        "palace_id",
        "hub_config_sha256",
        "sole_writer",
        "no_fallback",
        "approved",
        "approved_by",
        "approved_at",
    }
    if set(document) != required:
        raise ValidationError("authority receipt has unknown or missing fields")
    if authority_role not in {"source", "candidate"}:
        raise ValidationError("authority_role must be source or candidate")
    hub = config.source if authority_role == "source" else config.candidate
    expected = {
        "cutover_id": config.cutover_id,
        "authority_role": authority_role,
        "palace_id": hub.palace_id,
        "hub_config_sha256": hub.config_sha256,
        "sole_writer": True,
        "no_fallback": True,
        "approved": True,
    }
    for field, value in expected.items():
        if document.get(field) != value:
            raise ValidationError(f"authority receipt {field} mismatch")
    require_identifier(document.get("approved_by"), "authority.approved_by")
    require_utc_timestamp(document.get("approved_at"), "authority.approved_at")
    return document


def validate_fault_gate(path: Path, config: CutoverConfig) -> dict[str, Any]:
    """Require all hermetic ambiguous-outcome/idempotency/no-go fault tests."""

    document = _load_receipt(path, FAULT_GATE_RECEIPT)
    required = {
        "schema_version",
        "receipt_type",
        "cutover_id",
        "config_sha256",
        "status",
        "tests",
        "approved",
        "approved_by",
        "approved_at",
    }
    if set(document) != required:
        raise ValidationError("fault gate receipt has unknown or missing fields")
    tests = document.get("tests")
    if not isinstance(tests, dict) or set(tests) != REQUIRED_FAULT_TESTS:
        raise ValidationError(
            f"fault gate tests must contain exactly {sorted(REQUIRED_FAULT_TESTS)}"
        )
    if any(value is not True for value in tests.values()):
        raise ValidationError("fault gate has a failing test")
    if (
        document.get("cutover_id") != config.cutover_id
        or document.get("config_sha256") != config.config_sha256
        or document.get("status") != "PASS"
        or document.get("approved") is not True
    ):
        raise ValidationError("fault gate has not passed with operator approval")
    require_identifier(document.get("approved_by"), "fault_gate.approved_by")
    require_utc_timestamp(document.get("approved_at"), "fault_gate.approved_at")
    return document


def validate_operator_approval(
    path: Path,
    config: CutoverConfig,
    *,
    scope: str,
    subjects: Mapping[str, str],
) -> dict[str, Any]:
    """Require an operator decision over exact named SHA-256 subjects."""

    document = _load_receipt(path, OPERATOR_APPROVAL_RECEIPT)
    required = {
        "schema_version",
        "receipt_type",
        "approval_id",
        "cutover_id",
        "config_sha256",
        "scope",
        "decision",
        "subjects",
        "approved_by",
        "approved_at",
    }
    if set(document) != required:
        raise ValidationError("operator approval has unknown or missing fields")
    if (
        document.get("cutover_id") != config.cutover_id
        or document.get("config_sha256") != config.config_sha256
        or document.get("scope") != scope
        or document.get("decision") != "APPROVE"
    ):
        raise ValidationError(f"operator approval does not approve {scope}")
    require_identifier(document.get("approval_id"), "approval_id")
    require_identifier(document.get("approved_by"), "approved_by")
    require_utc_timestamp(document.get("approved_at"), "approved_at")
    raw_subjects = document.get("subjects")
    if not isinstance(raw_subjects, list):
        raise ValidationError("operator approval subjects must be a list")
    actual: dict[str, str] = {}
    for index, raw in enumerate(raw_subjects):
        if not isinstance(raw, dict) or set(raw) != {"name", "sha256"}:
            raise ValidationError(f"operator approval subject {index} is invalid")
        name = require_identifier(raw["name"], f"subjects[{index}].name")
        if name in actual:
            raise ValidationError("operator approval contains duplicate subjects")
        actual[name] = require_sha256(raw["sha256"], f"subjects[{index}].sha256")
    if actual != dict(subjects):
        raise ValidationError(f"operator approval subject mismatch for {scope}")
    return document


def load_evidence_bundle(path: Path, config: CutoverConfig, stage: str) -> EvidenceBundle:
    """Load an owner-only bundle and verify every referenced artifact hash."""

    bundle_path = require_absolute_path(str(path), "evidence_bundle")
    ensure_owner_only(bundle_path, "evidence_bundle")
    document = load_json_object(bundle_path)
    required = {
        "schema_version",
        "bundle_type",
        "cutover_id",
        "config_sha256",
        "stage",
        "artifacts",
        "claims",
    }
    if set(document) != required:
        raise ValidationError("evidence bundle has unknown or missing fields")
    _require_version(document, "evidence bundle")
    if document.get("bundle_type") != EVIDENCE_BUNDLE_TYPE:
        raise ValidationError(f"bundle_type must be {EVIDENCE_BUNDLE_TYPE}")
    if (
        document.get("cutover_id") != config.cutover_id
        or document.get("config_sha256") != config.config_sha256
        or document.get("stage") != stage
    ):
        raise ValidationError("evidence bundle identity/stage mismatch")
    raw_artifacts = document.get("artifacts")
    if not isinstance(raw_artifacts, list):
        raise ValidationError("evidence bundle artifacts must be a list")
    artifacts: dict[str, EvidenceArtifact] = {}
    for index, raw in enumerate(raw_artifacts):
        if not isinstance(raw, dict) or set(raw) != {"name", "path", "sha256"}:
            raise ValidationError(f"evidence artifact {index} is invalid")
        name = require_identifier(raw["name"], f"artifacts[{index}].name")
        if name in artifacts:
            raise ValidationError("evidence bundle contains duplicate artifact names")
        artifact_path = require_absolute_path(raw["path"], f"artifacts[{index}].path")
        ensure_owner_only(artifact_path, f"artifacts[{index}].path")
        digest = require_sha256(raw["sha256"], f"artifacts[{index}].sha256")
        if sha256_file(artifact_path) != digest:
            raise ValidationError(f"evidence artifact hash mismatch: {name}")
        artifacts[name] = EvidenceArtifact(name=name, path=artifact_path, sha256=digest)
    claims = document.get("claims")
    if not isinstance(claims, dict):
        raise ValidationError("evidence bundle claims must be an object")
    return EvidenceBundle(
        path=bundle_path,
        sha256=sha256_file(bundle_path),
        cutover_id=config.cutover_id,
        config_sha256=config.config_sha256,
        stage=stage,
        artifacts=artifacts,
        claims=cast(dict[str, Any], claims),
    )


def _require_artifact_names(bundle: EvidenceBundle, expected: set[str]) -> None:
    if set(bundle.artifacts) != expected:
        missing = sorted(expected - set(bundle.artifacts))
        extra = sorted(set(bundle.artifacts) - expected)
        raise ValidationError(f"{bundle.stage} evidence mismatch; missing={missing}, extra={extra}")


def _logical_reconciliation(path: Path) -> dict[str, Any]:
    document = _load_receipt(path, LOGICAL_RECONCILIATION_TYPE)
    if document.get("logical_equal") is not True:
        raise ValidationError("logical reconciliation is not exact")
    if any(document.get(field) != [] for field in ("missing", "extra", "changed")):
        raise ValidationError("logical reconciliation contains drift")
    return document


def _accepted_reconciliation(
    path: Path, journal_sha256: str, expected_count: int
) -> dict[str, Any]:
    document = _load_receipt(path, ACCEPTED_RECONCILIATION_TYPE)
    if (
        document.get("exact") is not True
        or document.get("operation_count") != expected_count
        or document.get("accepted_count") != expected_count
        or document.get("reconciled_count") != expected_count
        or document.get("pending_count") != 0
        or document.get("mismatches") != []
        or document.get("journal_sha256") != journal_sha256
    ):
        raise ValidationError("accepted-write reconciliation is not exact/current")
    return document


def validate_qualification_bundle(bundle: EvidenceBundle, config: CutoverConfig) -> None:
    """Enforce GATE-A/B1, data, disposition, shadow, authority, and fault gates."""

    names = {
        "gate-a",
        "gate-b1",
        "data-gate",
        "source-authority",
        "initial-drain",
        "source-export-manifest",
        "source-copy-receipt",
        "source-export-approval",
        "data-candidate-manifest",
        "data-candidate-copy",
        "data-reconciliation",
        "data-approval",
        "disposition-verification",
        "disposition-approval",
        "shadow-receipt",
        "shadow-approval",
        "fault-gate",
    }
    _require_artifact_names(bundle, names)
    if bundle.claims != {
        "source_sole_writer": True,
        "candidate_writes": False,
        "live_peak_cycle": "NOT RUN",
        "maintenance_cycle": "NOT RUN",
    }:
        raise ValidationError(
            "qualification claims must preserve source authority and NOT RUN cycles"
        )
    validate_release_gate(bundle.artifacts["gate-a"].path, config, "GATE-A")
    validate_release_gate(bundle.artifacts["gate-b1"].path, config, "GATE-B1")
    validate_release_gate(bundle.artifacts["data-gate"].path, config, "DATA-03")
    validate_authority_receipt(bundle.artifacts["source-authority"].path, config, "source")
    drain = validate_drain_receipt(bundle.artifacts["initial-drain"].path)
    source_manifest_path = bundle.artifacts["source-export-manifest"].path
    source_copy_path = bundle.artifacts["source-copy-receipt"].path
    source_manifest = validate_export_manifest(source_manifest_path)
    validate_copy_receipt(source_copy_path, source_manifest_path, source_manifest)
    if source_manifest.get("drain_receipt_sha256") != sha256_file(
        bundle.artifacts["initial-drain"].path
    ):
        raise ValidationError("source export does not bind the approved drain receipt")
    if source_manifest.get("source_id") != drain.get("source_id"):
        raise ValidationError("source export/drain source_id mismatch")
    validate_operator_approval(
        bundle.artifacts["source-export-approval"].path,
        config,
        scope="source-export",
        subjects={
            "manifest": bundle.artifacts["source-export-manifest"].sha256,
            "copy-receipt": bundle.artifacts["source-copy-receipt"].sha256,
            "drain-receipt": bundle.artifacts["initial-drain"].sha256,
        },
    )
    candidate_manifest_path = bundle.artifacts["data-candidate-manifest"].path
    candidate_manifest = validate_export_manifest(candidate_manifest_path)
    validate_copy_receipt(
        bundle.artifacts["data-candidate-copy"].path,
        candidate_manifest_path,
        candidate_manifest,
    )
    data = _logical_reconciliation(bundle.artifacts["data-reconciliation"].path)
    validate_operator_approval(
        bundle.artifacts["data-approval"].path,
        config,
        scope="data-reconciliation",
        subjects={
            "candidate-manifest": bundle.artifacts["data-candidate-manifest"].sha256,
            "candidate-copy": bundle.artifacts["data-candidate-copy"].sha256,
            "reconciliation": bundle.artifacts["data-reconciliation"].sha256,
        },
    )
    if (
        data.get("source", {}).get("manifest_sha256")
        != bundle.artifacts["source-export-manifest"].sha256
        or data.get("destination", {}).get("manifest_sha256")
        != bundle.artifacts["data-candidate-manifest"].sha256
    ):
        raise ValidationError("data reconciliation is not bound to both copied exports")
    disposition = _load_receipt(
        bundle.artifacts["disposition-verification"].path,
        DISPOSITION_VERIFICATION_TYPE,
    )
    if (
        disposition.get("verified") is not True
        or disposition.get("approval_required") is not True
        or disposition.get("pending_count") != 0
        or disposition.get("source_manifest_sha256")
        != bundle.artifacts["source-export-manifest"].sha256
    ):
        raise ValidationError("disposition is incomplete, pending, or not source-bound")
    validate_operator_approval(
        bundle.artifacts["disposition-approval"].path,
        config,
        scope="disposition",
        subjects={"verification": bundle.artifacts["disposition-verification"].sha256},
    )
    shadow = _load_receipt(bundle.artifacts["shadow-receipt"].path, SHADOW_RECEIPT_TYPE)
    if (
        shadow.get("cutover_id") != config.cutover_id
        or shadow.get("cutover_config_sha256") != config.config_sha256
        or shadow.get("source_config_sha256") != config.source.config_sha256
        or shadow.get("candidate_config_sha256") != config.candidate.config_sha256
        or shadow.get("source_sole_writer") is not True
        or shadow.get("candidate_write_count") != 0
        or shadow.get("passed") is not True
        or shadow.get("mismatch_count") != 0
        or shadow.get("source_authority_receipt_sha256")
        != bundle.artifacts["source-authority"].sha256
    ):
        raise ValidationError("shadow comparison has drift or lacks source-authority binding")
    validate_operator_approval(
        bundle.artifacts["shadow-approval"].path,
        config,
        scope="shadow-comparison",
        subjects={"shadow-receipt": bundle.artifacts["shadow-receipt"].sha256},
    )
    validate_fault_gate(bundle.artifacts["fault-gate"].path, config)


def _validate_drain_bundle(bundle: EvidenceBundle) -> None:
    _require_artifact_names(bundle, {"final-drain"})
    drain = validate_drain_receipt(bundle.artifacts["final-drain"].path)
    expected_claims = {"all_clients_drained": True, "source_writes_blocked": True}
    if drain.get("source_id") is None or bundle.claims != expected_claims:
        raise ValidationError("drain evidence does not block all source writes")


def _validate_final_delta_bundle(bundle: EvidenceBundle, config: CutoverConfig) -> None:
    names = {
        "final-source-manifest",
        "final-source-copy",
        "final-candidate-manifest",
        "final-candidate-copy",
        "final-reconciliation",
        "final-delta-approval",
    }
    _require_artifact_names(bundle, names)
    source_path = bundle.artifacts["final-source-manifest"].path
    candidate_path = bundle.artifacts["final-candidate-manifest"].path
    validate_copy_receipt(
        bundle.artifacts["final-source-copy"].path,
        source_path,
        validate_export_manifest(source_path),
    )
    validate_copy_receipt(
        bundle.artifacts["final-candidate-copy"].path,
        candidate_path,
        validate_export_manifest(candidate_path),
    )
    reconciliation = _logical_reconciliation(bundle.artifacts["final-reconciliation"].path)
    bound_source = reconciliation.get("source", {}).get("manifest_sha256")
    bound_candidate = reconciliation.get("destination", {}).get("manifest_sha256")
    if (
        bound_source != bundle.artifacts["final-source-manifest"].sha256
        or bound_candidate != bundle.artifacts["final-candidate-manifest"].sha256
    ):
        raise ValidationError("final reconciliation does not bind both final delta copies")
    validate_operator_approval(
        bundle.artifacts["final-delta-approval"].path,
        config,
        scope="final-delta",
        subjects={
            "source-manifest": bundle.artifacts["final-source-manifest"].sha256,
            "candidate-manifest": bundle.artifacts["final-candidate-manifest"].sha256,
            "reconciliation": bundle.artifacts["final-reconciliation"].sha256,
        },
    )
    if bundle.claims != {"logical_equal": True, "candidate_writes": False}:
        raise ValidationError("final delta claims must prove equality before candidate writes")


def _validate_canary_bundle(bundle: EvidenceBundle, config: CutoverConfig) -> None:
    _require_artifact_names(bundle, {"candidate-authority"})
    validate_authority_receipt(bundle.artifacts["candidate-authority"].path, config, "candidate")
    expected = {"bounded_client_set": True, "no_fallback": True, "post_ack_read": True}
    if bundle.claims != expected:
        raise ValidationError("canary authority claims are incomplete")


def _validate_cycle_evidence(path: Path, config: CutoverConfig) -> None:
    document = load_json_object(path)
    if set(document) != {
        "schema_version",
        "document_type",
        "cutover_id",
        "config_sha256",
        "live_peak_cycle",
        "diary_retention_maintenance_cycle",
        "production_expansion_authorized",
    }:
        raise ValidationError("canary cycle evidence has unknown or missing fields")
    if (
        document.get("schema_version") != EVIDENCE_SCHEMA_VERSION
        or document.get("document_type") != CANARY_CYCLE_EVIDENCE_TYPE
        or document.get("cutover_id") != config.cutover_id
        or document.get("config_sha256") != config.config_sha256
        or document.get("production_expansion_authorized") is not True
    ):
        raise ValidationError("canary cycle evidence does not authorize expansion")
    fields = {"status", "started_at", "completed_at", "evidence_sha256", "approved_by"}
    for name in ("live_peak_cycle", "diary_retention_maintenance_cycle"):
        cycle = document.get(name)
        if not isinstance(cycle, dict) or set(cycle) != fields or cycle.get("status") != "PASS":
            raise ValidationError(f"{name} is not a complete PASS")
        require_utc_timestamp(cycle.get("started_at"), f"{name}.started_at")
        require_utc_timestamp(cycle.get("completed_at"), f"{name}.completed_at")
        require_sha256(cycle.get("evidence_sha256"), f"{name}.evidence_sha256")
        require_identifier(cycle.get("approved_by"), f"{name}.approved_by")


def _validate_reconciliation_bundle(
    bundle: EvidenceBundle,
    config: CutoverConfig,
    journal_sha256: str | None,
    write_count: int,
) -> None:
    names = {"accepted-write-reconciliation"}
    if bundle.stage == "expand":
        names.add("cycle-evidence")
    _require_artifact_names(bundle, names)
    if journal_sha256 is None:
        raise ValidationError("journal hash is required for reconciliation evidence")
    reconciliation = _accepted_reconciliation(
        bundle.artifacts["accepted-write-reconciliation"].path,
        journal_sha256,
        write_count,
    )
    if reconciliation.get("target_role") != "candidate":
        raise ValidationError("canary reconciliation target must be candidate")
    expected: dict[str, Any] = {
        "accepted_write_count": write_count,
        "exact": True,
        "pending_count": 0,
    }
    if bundle.stage == "expand":
        _validate_cycle_evidence(bundle.artifacts["cycle-evidence"].path, config)
        expected.update({"live_peak_cycle": "PASS", "maintenance_cycle": "PASS"})
    if bundle.claims != expected:
        raise ValidationError("accepted-write reconciliation claims are stale or incomplete")


def _validate_replay_bundle(bundle: EvidenceBundle, config: CutoverConfig) -> None:
    names = {
        "candidate-preservation-manifest",
        "candidate-preservation-copy",
        "replay-source-authority",
        "replay-source-drain",
        "replay-compatibility",
        "replay-approval",
    }
    _require_artifact_names(bundle, names)
    manifest_path = bundle.artifacts["candidate-preservation-manifest"].path
    validate_copy_receipt(
        bundle.artifacts["candidate-preservation-copy"].path,
        manifest_path,
        validate_export_manifest(manifest_path),
    )
    validate_authority_receipt(bundle.artifacts["replay-source-authority"].path, config, "source")
    validate_drain_receipt(bundle.artifacts["replay-source-drain"].path)
    validate_release_gate(
        bundle.artifacts["replay-compatibility"].path,
        config,
        "REPLAY-COMPATIBILITY",
    )
    validate_operator_approval(
        bundle.artifacts["replay-approval"].path,
        config,
        scope="rollback-replay",
        subjects={
            "candidate-manifest": bundle.artifacts["candidate-preservation-manifest"].sha256,
            "candidate-copy": bundle.artifacts["candidate-preservation-copy"].sha256,
            "source-authority": bundle.artifacts["replay-source-authority"].sha256,
            "source-drain": bundle.artifacts["replay-source-drain"].sha256,
            "replay-compatibility": bundle.artifacts["replay-compatibility"].sha256,
        },
    )
    expected = {
        "candidate_preserved": True,
        "source_drained": True,
        "compatible_authority": True,
        "package_downgrade": False,
    }
    if bundle.claims != expected:
        raise ValidationError(
            "replay requires preservation, drain, compatibility, and no downgrade"
        )


def _validate_rollback_before(bundle: EvidenceBundle, write_count: int) -> None:
    names = {"restored-source-manifest", "restored-source-copy", "rollback-reconciliation"}
    _require_artifact_names(bundle, names)
    if write_count != 0:
        raise ValidationError("before-write rollback is prohibited after accepted candidate writes")
    manifest_path = bundle.artifacts["restored-source-manifest"].path
    validate_copy_receipt(
        bundle.artifacts["restored-source-copy"].path,
        manifest_path,
        validate_export_manifest(manifest_path),
    )
    reconciliation = _logical_reconciliation(bundle.artifacts["rollback-reconciliation"].path)
    reconciled_manifests = {
        reconciliation.get("source", {}).get("manifest_sha256"),
        reconciliation.get("destination", {}).get("manifest_sha256"),
    }
    if bundle.artifacts["restored-source-manifest"].sha256 not in reconciled_manifests:
        raise ValidationError("rollback reconciliation does not bind the restored source")
    expected = {
        "candidate_writes": False,
        "source_copy_restored": True,
        "package_downgrade": False,
    }
    if bundle.claims != expected:
        raise ValidationError("before-write rollback claims are incomplete")


def _validate_rollback_after(
    bundle: EvidenceBundle, write_count: int, source_journal_sha256: str | None
) -> None:
    names = {
        "candidate-preservation-manifest",
        "candidate-preservation-copy",
        "replay-receipt",
        "rollback-reconciliation",
    }
    _require_artifact_names(bundle, names)
    if write_count == 0:
        raise ValidationError("after-write rollback requires accepted candidate writes")
    manifest_path = bundle.artifacts["candidate-preservation-manifest"].path
    validate_copy_receipt(
        bundle.artifacts["candidate-preservation-copy"].path,
        manifest_path,
        validate_export_manifest(manifest_path),
    )
    replay = _load_receipt(bundle.artifacts["replay-receipt"].path, REPLAY_RECEIPT_TYPE)
    reconciliation = _load_receipt(
        bundle.artifacts["rollback-reconciliation"].path,
        ACCEPTED_RECONCILIATION_TYPE,
    )
    incomplete = (
        replay.get("exact") is not True
        or source_journal_sha256 is None
        or replay.get("source_journal_sha256") != source_journal_sha256
        or replay.get("operation_count") != write_count
        or replay.get("replayed_count") != write_count
        or replay.get("failures") != []
        or replay.get("target_role") != "source"
        or replay.get("package_downgrade") is not False
        or reconciliation.get("exact") is not True
        or reconciliation.get("operation_count") != write_count
        or reconciliation.get("accepted_count") != write_count
        or reconciliation.get("reconciled_count") != write_count
        or reconciliation.get("pending_count") != 0
        or reconciliation.get("mismatches") != []
        or reconciliation.get("target_role") != "source"
        or reconciliation.get("journal_sha256") != replay.get("replay_journal_sha256")
    )
    if incomplete:
        raise ValidationError("after-write rollback lacks exact replay/full reconciliation")
    expected = {
        "candidate_preserved": True,
        "exact_replay": True,
        "full_reconciliation": True,
        "package_downgrade": False,
    }
    if bundle.claims != expected:
        raise ValidationError("after-write rollback claims are incomplete")


def validate_transition_bundle(
    bundle: EvidenceBundle,
    config: CutoverConfig,
    *,
    journal_sha256: str | None = None,
    accepted_write_count: int = 0,
) -> None:
    """Validate stage-specific cutover, expansion, replay, or rollback evidence."""

    if bundle.stage == "drain":
        _validate_drain_bundle(bundle)
    elif bundle.stage == "final-delta":
        _validate_final_delta_bundle(bundle, config)
    elif bundle.stage == "canary":
        _validate_canary_bundle(bundle, config)
    elif bundle.stage in {"reconcile", "expand"}:
        _validate_reconciliation_bundle(bundle, config, journal_sha256, accepted_write_count)
    elif bundle.stage == "replay":
        _validate_replay_bundle(bundle, config)
    elif bundle.stage == "rollback-before-write":
        _validate_rollback_before(bundle, accepted_write_count)
    elif bundle.stage == "rollback-after-write":
        _validate_rollback_after(bundle, accepted_write_count, journal_sha256)
    else:
        raise ValidationError(f"unsupported evidence stage: {bundle.stage}")


def validate_one_time_approval(
    path: Path,
    config: CutoverConfig,
    *,
    action: str,
    evidence_sha256: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Validate a short-lived immutable capability bound to one action/bundle."""

    document = _load_receipt(path, ONE_TIME_APPROVAL_RECEIPT)
    required = {
        "schema_version",
        "receipt_type",
        "capability_id",
        "nonce",
        "cutover_id",
        "config_sha256",
        "action",
        "evidence_sha256",
        "approved_by",
        "approved_at",
        "expires_at",
    }
    if set(document) != required:
        raise ValidationError("one-time approval has unknown or missing fields")
    if (
        document.get("cutover_id") != config.cutover_id
        or document.get("config_sha256") != config.config_sha256
        or document.get("action") != action
        or document.get("evidence_sha256") != evidence_sha256
    ):
        raise ValidationError("one-time approval is not bound to this action/evidence")
    require_identifier(document.get("capability_id"), "capability_id")
    require_identifier(document.get("nonce"), "nonce")
    require_identifier(document.get("approved_by"), "approved_by")
    require_utc_timestamp(document.get("approved_at"), "approved_at")
    expires_at = require_utc_timestamp(document.get("expires_at"), "expires_at")
    current = now or datetime.now(timezone.utc)
    expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    if current.astimezone(timezone.utc) >= expiry:
        raise ValidationError("one-time approval has expired")
    return document


def _parse_approval_ledger(raw: bytes, config: CutoverConfig) -> set[str]:
    if raw and not raw.endswith(b"\n"):
        raise ValidationError("approval ledger has an incomplete trailing record")
    consumed_ids: set[str] = set()
    fields = {
        "schema_version",
        "ledger_type",
        "sequence",
        "cutover_id",
        "capability_id",
        "approval_sha256",
        "action",
        "evidence_sha256",
        "consumed_at",
    }
    for line_number, line in enumerate(raw.splitlines(), start=1):
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValidationError(f"approval ledger line {line_number} is invalid") from exc
        if not isinstance(record, dict) or set(record) != fields:
            raise ValidationError(f"approval ledger line {line_number} is malformed")
        if (
            record.get("schema_version") != EVIDENCE_SCHEMA_VERSION
            or record.get("ledger_type") != APPROVAL_LEDGER_TYPE
            or record.get("sequence") != line_number
            or record.get("cutover_id") != config.cutover_id
        ):
            raise ValidationError("approval ledger identity/sequence mismatch")
        capability_id = require_identifier(record.get("capability_id"), "capability_id")
        if capability_id in consumed_ids:
            raise ValidationError("approval ledger contains a duplicate capability")
        consumed_ids.add(capability_id)
        require_sha256(record.get("approval_sha256"), "approval_sha256")
        require_identifier(record.get("action"), "action")
        require_sha256(record.get("evidence_sha256"), "evidence_sha256")
        require_utc_timestamp(record.get("consumed_at"), "consumed_at")
    return consumed_ids


def _burn_capability(
    config: CutoverConfig,
    approval_path: Path,
    approval: Mapping[str, Any],
    *,
    action: str,
    evidence_sha256: str,
) -> None:
    ledger = config.approval_ledger_path
    if ledger.is_symlink():
        raise ValidationError("approval ledger must not be a symlink")
    ledger.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    flags = os.O_RDWR | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(ledger, flags, APPROVAL_LEDGER_MODE)
    try:
        file_stat = os.fstat(descriptor)
        if (
            not stat.S_ISREG(file_stat.st_mode)
            or file_stat.st_uid != os.geteuid()
            or stat.S_IMODE(file_stat.st_mode) != APPROVAL_LEDGER_MODE
        ):
            raise ValidationError("approval ledger must be current-user owned with mode 0600")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        size = os.fstat(descriptor).st_size
        if size > MAX_APPROVAL_LEDGER_BYTES:
            raise ValidationError("approval ledger exceeds its hard bound")
        os.lseek(descriptor, 0, os.SEEK_SET)
        raw = os.read(descriptor, size)
        consumed_ids = _parse_approval_ledger(raw, config)
        capability_id = cast(str, approval["capability_id"])
        if capability_id in consumed_ids:
            raise ValidationError("one-time approval capability has already been consumed")
        ledger_record = {
            "schema_version": EVIDENCE_SCHEMA_VERSION,
            "ledger_type": APPROVAL_LEDGER_TYPE,
            "sequence": len(consumed_ids) + 1,
            "cutover_id": config.cutover_id,
            "capability_id": capability_id,
            "approval_sha256": sha256_file(approval_path),
            "action": action,
            "evidence_sha256": evidence_sha256,
            "consumed_at": utc_now(),
        }
        payload = canonical_json_bytes(ledger_record)
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("short append to approval ledger")
            view = view[written:]
        os.fsync(descriptor)
        directory_fd = os.open(ledger.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        os.close(descriptor)


def consume_one_time_approval(
    approval_path: Path,
    consumption_path: Path,
    config: CutoverConfig,
    *,
    action: str,
    evidence_sha256: str,
) -> dict[str, Any]:
    """Burn a capability in the configured ledger before any cutover mutation."""

    destination = require_absolute_path(str(consumption_path), "consumption", must_exist=False)
    if destination.exists() or destination.is_symlink():
        raise ValidationError(f"refusing to overwrite consumption receipt: {destination}")
    approval = validate_one_time_approval(
        approval_path,
        config,
        action=action,
        evidence_sha256=evidence_sha256,
    )
    _burn_capability(
        config,
        approval_path,
        approval,
        action=action,
        evidence_sha256=evidence_sha256,
    )
    receipt: dict[str, Any] = {
        "schema_version": EVIDENCE_SCHEMA_VERSION,
        "receipt_type": APPROVAL_CONSUMPTION_RECEIPT,
        "cutover_id": config.cutover_id,
        "config_sha256": config.config_sha256,
        "capability_id": approval["capability_id"],
        "approval_sha256": sha256_file(approval_path),
        "action": action,
        "evidence_sha256": evidence_sha256,
        "consumed_at": utc_now(),
    }
    atomic_write_json(destination, receipt)
    return receipt
