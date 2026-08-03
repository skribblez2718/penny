"""P0 code-run artifact contracts, quality floor, profiles, and completion coverage.

This module is the canonical schema boundary for the code skill's P0 artifacts.
Payloads are immutable, digest-bound JSON; SQLite persistence and CAS selection are
provided by :class:`orchestration.checkpointer.Checkpointer`.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import shlex
import subprocess
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence, cast

ARTIFACT_SCHEMA_VERSION = 1
QUALITY_FLOOR_SCHEMA_VERSION = 1
QUALITY_FLOOR_STATUS_SCHEMA_VERSION = 1
P0_VERIFICATION_MANIFEST_SCHEMA_VERSION = 2
TARGET_PROFILE_SCHEMA_VERSION = 1
COVERAGE_MAP_SCHEMA_VERSION = 1
APPROVAL_SCHEMA_VERSION = 2

ARTIFACT_KINDS: frozenset[str] = frozenset(
    {
        "scope_leak_manifest",
        "worktree_preservation",
        "quality_floor",
        "quality_floor_status",
        "target_profile",
        "echo_exploration",
        "annie_findings",
        "annie_disposition",
        "ideal_state_revision",
        "criteria_review",
        "criteria_approval",
        "piper_plan",
        "plan_approval",
        "questionnaire_transport",
        "execution_receipt",
        "implementation",
        "verification_result",
        "learning_result",
        "coverage_map",
        "security_disposition",
        "human_risk_acceptance",
        "p0_verification_manifest",
        "eval_baseline",
        "contract_drift_matrix",
        "terminal_result",
        "outcome",
    }
)

QUALITY_DIMENSIONS: tuple[tuple[str, str], ...] = (
    (
        "security",
        "The change prevents introduced security vulnerabilities and resolves or explicitly human-accepts every residual security risk.",
    ),
    (
        "production_readiness",
        "The change is operationally ready for the selected target scope and its evidenced runtime constraints.",
    ),
    (
        "target_idiom",
        "The change follows the selected target profile's evidenced language, framework, and project conventions.",
    ),
    (
        "harmful_duplication_avoidance",
        "The change introduces no harmful duplicated source of truth or repeated non-trivial logic.",
    ),
    (
        "unnecessary_complexity_avoidance",
        "The change contains no complexity that is unnecessary for the selected criteria and target scope.",
    ),
    (
        "regression_freedom",
        "The selected verification and full-eval comparison show no new or worsened regression.",
    ),
)
QUALITY_DIMENSION_IDS: tuple[str, ...] = tuple(item[0] for item in QUALITY_DIMENSIONS)
EVIDENCE_CLASSES: frozenset[str] = frozenset({"command-verifiable", "judgment-only"})
FINDING_STATES: frozenset[str] = frozenset(
    {"remediated", "not_applicable", "unresolved", "human_accepted_residual_risk"}
)


class ArtifactValidationError(ValueError):
    """An artifact is malformed, stale, cross-run, or integrity-invalid."""


class SelectionConflictError(RuntimeError):
    """A compare-and-swap artifact selection used a stale expected selection."""


def utc_now() -> str:
    """Return an explicit UTC timestamp."""
    return datetime.now(timezone.utc).isoformat()


def canonical_json(value: Any) -> bytes:
    """Encode JSON deterministically for digest/signature operations."""
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")


def sha256_json(value: Any) -> str:
    """Return a SHA-256 digest of canonical JSON."""
    return hashlib.sha256(canonical_json(value)).hexdigest()


def _require_keys(value: Mapping[str, Any], expected: frozenset[str], label: str) -> None:
    actual = frozenset(value)
    if actual != expected:
        raise ArtifactValidationError(
            f"{label} must contain exactly {sorted(expected)}; got {sorted(actual)}"
        )


def _parse_utc(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise ArtifactValidationError(f"{label} must be a non-empty ISO-8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ArtifactValidationError(f"{label} must be parseable ISO-8601") from exc
    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise ArtifactValidationError(f"{label} must carry an explicit UTC offset")
    return parsed


@dataclass(frozen=True)
class ArtifactRef:
    """Stable reference to one immutable artifact version."""

    artifact_id: str
    kind: str
    version: int
    digest: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "artifact_id": self.artifact_id,
            "kind": self.kind,
            "version": self.version,
            "digest": self.digest,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "ArtifactRef":
        _require_keys(
            value, frozenset({"artifact_id", "kind", "version", "digest"}), "artifact ref"
        )
        artifact_id = value["artifact_id"]
        kind = value["kind"]
        version = value["version"]
        digest = value["digest"]
        if not isinstance(artifact_id, str) or not artifact_id:
            raise ArtifactValidationError("artifact ref artifact_id must be non-empty")
        if kind not in ARTIFACT_KINDS:
            raise ArtifactValidationError(f"unknown artifact ref kind {kind!r}")
        if type(version) is not int or version < 1:
            raise ArtifactValidationError("artifact ref version must be a positive integer")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ArtifactValidationError("artifact ref digest must be lowercase SHA-256")
        return cls(artifact_id=artifact_id, kind=kind, version=version, digest=digest)


_ENVELOPE_KEYS = frozenset(
    {
        "schema_version",
        "artifact_id",
        "run_id",
        "kind",
        "version",
        "created_at",
        "producer",
        "authority",
        "payload",
        "payload_digest",
        "parent_ref",
        "upstream_refs",
        "envelope_digest",
    }
)


@dataclass(frozen=True)
class ArtifactEnvelope:
    """Immutable, run-bound, integrity-verifiable artifact envelope."""

    schema_version: int
    artifact_id: str
    run_id: str
    kind: str
    version: int
    created_at: str
    producer: str
    authority: str
    payload: Any
    payload_digest: str
    parent_ref: ArtifactRef | None
    upstream_refs: tuple[ArtifactRef, ...]
    envelope_digest: str

    def unsigned_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "artifact_id": self.artifact_id,
            "run_id": self.run_id,
            "kind": self.kind,
            "version": self.version,
            "created_at": self.created_at,
            "producer": self.producer,
            "authority": self.authority,
            "payload": deepcopy(self.payload),
            "payload_digest": self.payload_digest,
            "parent_ref": self.parent_ref.to_dict() if self.parent_ref else None,
            "upstream_refs": [reference.to_dict() for reference in self.upstream_refs],
        }

    def to_dict(self) -> dict[str, Any]:
        return {**self.unsigned_dict(), "envelope_digest": self.envelope_digest}

    def ref(self) -> ArtifactRef:
        return ArtifactRef(self.artifact_id, self.kind, self.version, self.envelope_digest)

    @classmethod
    def create(
        cls,
        *,
        run_id: str,
        kind: str,
        version: int,
        payload: Any,
        producer: str,
        authority: str,
        parent_ref: ArtifactRef | None = None,
        upstream_refs: Sequence[ArtifactRef] = (),
        artifact_id: str | None = None,
        created_at: str | None = None,
    ) -> "ArtifactEnvelope":
        if not isinstance(run_id, str) or not run_id:
            raise ArtifactValidationError("run_id must be non-empty")
        if kind not in ARTIFACT_KINDS:
            raise ArtifactValidationError(f"unknown artifact kind {kind!r}")
        if type(version) is not int or version < 1:
            raise ArtifactValidationError("artifact version must be a positive integer")
        if not isinstance(producer, str) or not producer:
            raise ArtifactValidationError("producer must be non-empty")
        if not isinstance(authority, str) or not authority:
            raise ArtifactValidationError("authority must be non-empty")
        timestamp = created_at or utc_now()
        _parse_utc(timestamp, "created_at")
        identifier = artifact_id or f"{run_id}:{kind}:v{version}:{secrets.token_hex(8)}"
        payload_digest = sha256_json(payload)
        candidate = {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "artifact_id": identifier,
            "run_id": run_id,
            "kind": kind,
            "version": version,
            "created_at": timestamp,
            "producer": producer,
            "authority": authority,
            "payload": deepcopy(payload),
            "payload_digest": payload_digest,
            "parent_ref": parent_ref.to_dict() if parent_ref else None,
            "upstream_refs": [reference.to_dict() for reference in upstream_refs],
        }
        return cls(
            schema_version=ARTIFACT_SCHEMA_VERSION,
            artifact_id=identifier,
            run_id=run_id,
            kind=kind,
            version=version,
            created_at=timestamp,
            producer=producer,
            authority=authority,
            payload=deepcopy(payload),
            payload_digest=payload_digest,
            parent_ref=parent_ref,
            upstream_refs=tuple(upstream_refs),
            envelope_digest=sha256_json(candidate),
        )

    @classmethod
    def from_dict(  # noqa: C901 - fail-closed schema and integrity validation
        cls, value: Mapping[str, Any], *, expected_run_id: str | None = None
    ) -> "ArtifactEnvelope":
        _require_keys(value, _ENVELOPE_KEYS, "artifact envelope")
        schema_version = value["schema_version"]
        if schema_version != ARTIFACT_SCHEMA_VERSION:
            raise ArtifactValidationError(
                f"unsupported artifact schema_version {schema_version!r}; record preserved"
            )
        run_id = value["run_id"]
        if not isinstance(run_id, str) or not run_id:
            raise ArtifactValidationError("artifact run_id must be non-empty")
        if expected_run_id is not None and run_id != expected_run_id:
            raise ArtifactValidationError(
                f"wrong-run artifact: expected {expected_run_id!r}, got {run_id!r}"
            )
        kind = value["kind"]
        if kind not in ARTIFACT_KINDS:
            raise ArtifactValidationError(f"unknown artifact kind {kind!r}")
        version = value["version"]
        if type(version) is not int or version < 1:
            raise ArtifactValidationError("artifact version must be a positive integer")
        artifact_id = value["artifact_id"]
        if not isinstance(artifact_id, str) or not artifact_id:
            raise ArtifactValidationError("artifact_id must be non-empty")
        producer = value["producer"]
        authority = value["authority"]
        if not isinstance(producer, str) or not producer:
            raise ArtifactValidationError("producer must be non-empty")
        if not isinstance(authority, str) or not authority:
            raise ArtifactValidationError("authority must be non-empty")
        created_at = value["created_at"]
        _parse_utc(created_at, "created_at")
        payload = deepcopy(value["payload"])
        payload_digest = value["payload_digest"]
        if payload_digest != sha256_json(payload):
            raise ArtifactValidationError("artifact payload digest mismatch")
        parent_value = value["parent_ref"]
        parent_ref = (
            ArtifactRef.from_dict(parent_value) if isinstance(parent_value, Mapping) else None
        )
        if parent_value is not None and parent_ref is None:
            raise ArtifactValidationError("parent_ref must be an object or null")
        upstream_values = value["upstream_refs"]
        if not isinstance(upstream_values, list):
            raise ArtifactValidationError("upstream_refs must be a list")
        upstream_refs = tuple(ArtifactRef.from_dict(item) for item in upstream_values)
        unsigned = {key: deepcopy(value[key]) for key in _ENVELOPE_KEYS - {"envelope_digest"}}
        envelope_digest = value["envelope_digest"]
        if envelope_digest != sha256_json(unsigned):
            raise ArtifactValidationError("artifact envelope digest mismatch")
        return cls(
            schema_version=schema_version,
            artifact_id=artifact_id,
            run_id=run_id,
            kind=kind,
            version=version,
            created_at=created_at,
            producer=producer,
            authority=authority,
            payload=payload,
            payload_digest=payload_digest,
            parent_ref=parent_ref,
            upstream_refs=upstream_refs,
            envelope_digest=envelope_digest,
        )


class ArtifactRegistry:
    """Typed facade over the checkpointer's transactional P0 artifact store."""

    def __init__(self, checkpointer: Any, run_id: str) -> None:
        self.checkpointer = checkpointer
        self.run_id = run_id

    def register(self, envelope: ArtifactEnvelope, *, select: bool = False) -> ArtifactRef:
        if envelope.run_id != self.run_id:
            raise ArtifactValidationError("cannot register an artifact for another run")
        current = self.selected(envelope.kind) if select else None
        if envelope.kind == "eval_baseline" and current is not None and current != envelope.ref():
            raise SelectionConflictError(
                "the selected immutable eval baseline cannot be reset in the same run"
            )
        self.checkpointer.put_artifact(envelope.to_dict())
        if select:
            self.checkpointer.select_artifact(
                run_id=self.run_id,
                kind=envelope.kind,
                artifact_id=envelope.artifact_id,
                version=envelope.version,
                expected_artifact_id=current.artifact_id if current else None,
            )
        return envelope.ref()

    def create_and_register(
        self,
        *,
        kind: str,
        payload: Any,
        producer: str,
        authority: str,
        select: bool = True,
        upstream_refs: Sequence[ArtifactRef] = (),
    ) -> ArtifactRef:
        current = self.selected(kind)
        envelope = ArtifactEnvelope.create(
            run_id=self.run_id,
            kind=kind,
            version=(current.version + 1) if current else 1,
            payload=payload,
            producer=producer,
            authority=authority,
            parent_ref=current,
            upstream_refs=upstream_refs,
        )
        return self.register(envelope, select=select)

    def selected(self, kind: str) -> ArtifactRef | None:
        raw = self.checkpointer.get_selected_artifact(self.run_id, kind)
        return ArtifactRef.from_dict(raw) if raw else None

    def get(self, reference: ArtifactRef) -> ArtifactEnvelope:
        raw = self.checkpointer.get_artifact(reference.artifact_id)
        if raw is None:
            raise ArtifactValidationError(f"missing artifact {reference.artifact_id!r}")
        envelope = ArtifactEnvelope.from_dict(raw, expected_run_id=self.run_id)
        if envelope.ref() != reference:
            raise ArtifactValidationError("artifact reference does not match recovered content")
        return envelope

    def selections(self) -> dict[str, ArtifactRef]:
        return {
            kind: ArtifactRef.from_dict(reference)
            for kind, reference in self.checkpointer.list_selected_artifacts(self.run_id).items()
        }


def new_quality_floor() -> dict[str, Any]:
    """Create the selected non-waivable six-dimension floor for a new run."""
    return {
        "schema_version": QUALITY_FLOOR_SCHEMA_VERSION,
        "dimensions": [
            {
                "id": dimension_id,
                "definition": definition,
                "status": "unresolved",
                "evidence_class": None,
                "evidence_refs": [],
                "eligible_disposition_refs": [],
            }
            for dimension_id, definition in QUALITY_DIMENSIONS
        ],
    }


def validate_quality_floor(value: Any) -> list[str]:  # noqa: C901
    errors: list[str] = []
    if not isinstance(value, dict):
        return ["quality floor must be an object"]
    if set(value) != {"schema_version", "dimensions"}:
        errors.append("quality floor must contain exactly schema_version and dimensions")
    if value.get("schema_version") != QUALITY_FLOOR_SCHEMA_VERSION:
        errors.append("unsupported quality floor schema version")
    dimensions = value.get("dimensions")
    if not isinstance(dimensions, list):
        return errors + ["quality floor dimensions must be a list"]
    ids = [item.get("id") for item in dimensions if isinstance(item, dict)]
    if tuple(ids) != QUALITY_DIMENSION_IDS or len(dimensions) != len(QUALITY_DIMENSION_IDS):
        errors.append(f"quality floor must contain exactly {list(QUALITY_DIMENSION_IDS)} in order")
    definitions = dict(QUALITY_DIMENSIONS)
    for index, dimension in enumerate(dimensions):
        path = f"dimensions[{index}]"
        if not isinstance(dimension, dict):
            errors.append(f"{path} must be an object")
            continue
        required = {
            "id",
            "definition",
            "status",
            "evidence_class",
            "evidence_refs",
            "eligible_disposition_refs",
        }
        if set(dimension) != required:
            errors.append(f"{path} has a stale or missing field")
            continue
        dimension_id = dimension["id"]
        if dimension.get("definition") != definitions.get(dimension_id):
            errors.append(f"{path} reinterprets the canonical definition")
        if dimension.get("status") not in {"unresolved", "satisfied"}:
            errors.append(f"{path} status cannot be waived, disabled, or not-applicable")
        evidence_class = dimension.get("evidence_class")
        if evidence_class is not None and evidence_class not in EVIDENCE_CLASSES:
            errors.append(f"{path} has an unknown evidence class")
        if not isinstance(dimension.get("evidence_refs"), list):
            errors.append(f"{path}.evidence_refs must be a list")
        if not isinstance(dimension.get("eligible_disposition_refs"), list):
            errors.append(f"{path}.eligible_disposition_refs must be a list")
    return errors


def new_quality_floor_status(
    floor_ref: ArtifactRef, coverage_ref: ArtifactRef, coverage: Any
) -> dict[str, Any]:
    """Build the engine-owned status overlay for one immutable selected floor."""
    obligations = coverage.get("obligations", []) if isinstance(coverage, dict) else []
    by_id = {
        str(item.get("id")): item
        for item in obligations
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    dimensions: list[dict[str, Any]] = []
    for dimension_id, definition in QUALITY_DIMENSIONS:
        obligation = by_id.get(f"quality:{dimension_id}", {})
        evidence_class = obligation.get("evidence_class")
        evidence_refs = obligation.get("evidence_refs", [])
        satisfied = (
            obligation.get("status") == "satisfied"
            and evidence_class in EVIDENCE_CLASSES
            and isinstance(evidence_refs, list)
            and bool(evidence_refs)
        )
        dimensions.append(
            {
                "id": dimension_id,
                "definition": definition,
                "status": "satisfied" if satisfied else "unresolved",
                "evidence_class": evidence_class if evidence_class in EVIDENCE_CLASSES else None,
                "evidence_refs": deepcopy(evidence_refs) if isinstance(evidence_refs, list) else [],
                "eligible_disposition_refs": (
                    deepcopy(evidence_refs)
                    if evidence_class == "judgment-only" and isinstance(evidence_refs, list)
                    else []
                ),
            }
        )
    return {
        "schema_version": QUALITY_FLOOR_STATUS_SCHEMA_VERSION,
        "quality_floor_ref": floor_ref.to_dict(),
        "coverage_map_ref": coverage_ref.to_dict(),
        "dimensions": dimensions,
    }


def validate_quality_floor_status(
    value: Any,
    *,
    floor_ref: ArtifactRef,
    coverage_ref: ArtifactRef,
    coverage: Any,
) -> list[str]:
    """Require floor statuses/classes/references to match terminal coverage exactly."""
    if not isinstance(value, dict) or set(value) != {
        "schema_version",
        "quality_floor_ref",
        "coverage_map_ref",
        "dimensions",
    }:
        return ["quality-floor status overlay has missing or stale fields"]
    errors: list[str] = []
    if value.get("schema_version") != QUALITY_FLOOR_STATUS_SCHEMA_VERSION:
        errors.append("quality-floor status overlay schema version is unsupported")
    if value.get("quality_floor_ref") != floor_ref.to_dict():
        errors.append("quality-floor status overlay is bound to a different floor version")
    if value.get("coverage_map_ref") != coverage_ref.to_dict():
        errors.append("quality-floor status overlay is bound to a different coverage map")
    expected = new_quality_floor_status(floor_ref, coverage_ref, coverage)
    if value.get("dimensions") != expected["dimensions"]:
        errors.append("quality-floor statuses/evidence do not reconcile with coverage")
    dimensions = value.get("dimensions")
    if not isinstance(dimensions, list) or any(
        not isinstance(item, dict) or item.get("status") != "satisfied" for item in dimensions
    ):
        errors.append("all six quality-floor dimensions must be satisfied")
    return errors


_RELEASE_INPUT_IDS = {
    "scope_leak_manifest": "manifest_id",
    "verification_manifest": "manifest_id",
    "contract_drift_matrix": "matrix_id",
}


def selected_release_input_identity(kind: str, payload: Any) -> dict[str, Any]:
    """Return the canonical selected manifest identity used by the release baseline."""
    id_field = _RELEASE_INPUT_IDS.get(kind)
    if id_field is None or not isinstance(payload, dict):
        raise ArtifactValidationError(f"unknown or malformed selected release input {kind!r}")
    artifact_id = payload.get(id_field)
    schema_version = payload.get("schema_version")
    version = payload.get("version")
    if not isinstance(artifact_id, str) or not artifact_id:
        raise ArtifactValidationError(f"selected release input {kind!r} has no artifact id")
    if type(schema_version) is not int or schema_version < 1:
        raise ArtifactValidationError(f"selected release input {kind!r} has no schema version")
    if type(version) is not int or version < 1:
        raise ArtifactValidationError(f"selected release input {kind!r} has no version")
    return {
        "artifact_id": artifact_id,
        "schema_version": schema_version,
        "version": version,
        "digest": sha256_json(payload),
    }


def validate_selected_release_inputs(value: Any) -> list[str]:
    """Validate all three selected manifest identities without reading ambient files."""
    if not isinstance(value, dict) or set(value) != set(_RELEASE_INPUT_IDS):
        return ["eval baseline selected release inputs are missing or stale"]
    errors: list[str] = []
    expected_fields = {"artifact_id", "schema_version", "version", "digest"}
    for kind, identity in value.items():
        if not isinstance(identity, dict) or set(identity) != expected_fields:
            errors.append(f"selected release input {kind!r} identity is incomplete")
            continue
        if not isinstance(identity.get("artifact_id"), str) or not identity["artifact_id"]:
            errors.append(f"selected release input {kind!r} id is missing")
        if type(identity.get("schema_version")) is not int or identity["schema_version"] < 1:
            errors.append(f"selected release input {kind!r} schema version is invalid")
        if type(identity.get("version")) is not int or identity["version"] < 1:
            errors.append(f"selected release input {kind!r} version is invalid")
        if not isinstance(identity.get("digest"), str) or not re.fullmatch(
            r"[0-9a-f]{64}", identity["digest"]
        ):
            errors.append(f"selected release input {kind!r} digest is invalid")
    return errors


def validate_selected_release_input_binding(
    selected_inputs: Any, payloads: Mapping[str, Any]
) -> list[str]:
    """Compare selected baseline identities with the exact dependent artifact payloads."""
    errors = validate_selected_release_inputs(selected_inputs)
    if errors:
        return errors
    for kind in _RELEASE_INPUT_IDS:
        try:
            current = selected_release_input_identity(kind, payloads.get(kind))
        except ArtifactValidationError as exc:
            errors.append(str(exc))
            continue
        if selected_inputs.get(kind) != current:
            errors.append(f"selected {kind} identity/version/digest changed")
    return errors


def validate_eval_baseline(value: Any) -> list[str]:  # noqa: C901 - complete baseline contract
    """Validate the immutable pre-edit full-eval identity and frozen comparator."""
    if not isinstance(value, dict):
        return ["eval baseline must be an object"]
    required = {
        "schema_version",
        "immutable",
        "captured_at",
        "command_argv",
        "working_directory",
        "source_identity",
        "selected_inputs",
        "normalized_outcomes",
        "comparator",
        "raw_output_ref",
        "raw_output_digest",
        "digest",
    }
    errors: list[str] = []
    if set(value) != required:
        errors.append("eval baseline has missing, unknown, or stale fields")
    if value.get("schema_version") != 2:
        errors.append("eval baseline schema version is unsupported")
    if value.get("immutable") is not True:
        errors.append("eval baseline is not marked immutable")
    try:
        _parse_utc(value.get("captured_at"), "eval baseline captured_at")
    except ArtifactValidationError as exc:
        errors.append(str(exc))
    argv = value.get("command_argv")
    if (
        not isinstance(argv, list)
        or not argv
        or any(not isinstance(item, str) or not item or "\x00" in item for item in argv)
    ):
        errors.append("eval baseline command argv is missing or unsafe")
    working_directory = value.get("working_directory")
    if not isinstance(working_directory, str) or not Path(working_directory).is_absolute():
        errors.append("eval baseline working directory must be canonical and absolute")
    source = value.get("source_identity")
    if not isinstance(source, dict) or set(source) != {
        "head",
        "worktree_digest",
        "worktree_records",
    }:
        errors.append("eval baseline source identity is incomplete")
    else:
        if not isinstance(source.get("head"), str) or not source["head"]:
            errors.append("eval baseline source HEAD is missing")
        records = source.get("worktree_records")
        if not isinstance(records, list):
            errors.append("eval baseline worktree records must be a list")
        else:
            record_paths: list[str] = []
            required_record_fields = {
                "path",
                "index_status",
                "worktree_status",
                "exists",
                "mode",
                "sha256",
                "index_blob",
            }
            for record in records:
                if not isinstance(record, dict) or not required_record_fields <= set(record):
                    errors.append("eval baseline has an incomplete worktree identity record")
                    continue
                record_path = record.get("path")
                if (
                    not isinstance(record_path, str)
                    or not record_path
                    or Path(record_path).is_absolute()
                    or ".." in Path(record_path).parts
                ):
                    errors.append("eval baseline has an unsafe worktree identity path")
                else:
                    record_paths.append(record_path)
                if record.get("index_status") not in {
                    " ",
                    "M",
                    "T",
                    "A",
                    "D",
                    "R",
                    "C",
                    "U",
                    "?",
                    "!",
                    "X",
                }:
                    errors.append("eval baseline has an invalid index status")
                if record.get("worktree_status") not in {
                    " ",
                    "M",
                    "T",
                    "A",
                    "D",
                    "R",
                    "C",
                    "U",
                    "?",
                    "!",
                    "X",
                }:
                    errors.append("eval baseline has an invalid worktree status")
                if type(record.get("exists")) is not bool:
                    errors.append("eval baseline worktree existence state is invalid")
            if len(record_paths) != len(set(record_paths)):
                errors.append("eval baseline has duplicate worktree identity paths")
        expected_worktree_digest = sha256_json(source.get("worktree_records"))
        if source.get("worktree_digest") != expected_worktree_digest:
            errors.append("eval baseline worktree identity digest changed")
    errors.extend(validate_selected_release_inputs(value.get("selected_inputs")))
    outcomes = value.get("normalized_outcomes")
    results = outcomes.get("results") if isinstance(outcomes, dict) else None
    if not isinstance(results, list) or not results:
        errors.append("eval baseline has no complete normalized outcomes")
    else:
        names = [item.get("name") for item in results if isinstance(item, dict)]
        if len(names) != len(results) or any(
            not isinstance(name, str) or not name for name in names
        ):
            errors.append("eval baseline contains a malformed result identity")
        elif len(names) != len(set(names)):
            errors.append("eval baseline contains duplicate result identities")
    comparator = value.get("comparator")
    if comparator != {"id": "p0-full-eval-v1", "frozen": True}:
        errors.append("eval baseline comparator is missing, mutable, or unsupported")
    for field in ("raw_output_ref", "raw_output_digest"):
        if not isinstance(value.get(field), str) or not value[field]:
            errors.append(f"eval baseline {field} must be non-empty")
    raw_digest = value.get("raw_output_digest")
    if isinstance(raw_digest, str) and not re.fullmatch(r"[0-9a-f]{64}", raw_digest):
        errors.append("eval baseline raw output digest must be lowercase SHA-256")
    raw_ref = value.get("raw_output_ref")
    if isinstance(raw_ref, str) and raw_ref:
        raw_path = Path(raw_ref)
        if not raw_path.is_absolute():
            errors.append("eval baseline raw output reference must be absolute")
        elif raw_path.is_symlink() or not raw_path.is_file():
            errors.append("eval baseline raw output artifact is missing or unsafe")
        else:
            try:
                mode = raw_path.stat().st_mode & 0o777
                if mode & 0o077:
                    errors.append("eval baseline raw output artifact is not owner-only")
                actual_raw_digest = hashlib.sha256(raw_path.read_bytes()).hexdigest()
                if raw_digest != actual_raw_digest:
                    errors.append("eval baseline raw output artifact digest changed")
                if isinstance(working_directory, str) and Path(working_directory).is_absolute():
                    target_root = Path(working_directory).resolve()
                    canonical_raw = raw_path.resolve()
                    if canonical_raw == target_root or target_root in canonical_raw.parents:
                        errors.append("eval baseline raw output artifact is inside the target tree")
            except OSError as exc:
                errors.append(f"eval baseline raw output artifact is unreadable: {exc}")
    baseline_unsigned = {key: child for key, child in value.items() if key != "digest"}
    if value.get("digest") != sha256_json(baseline_unsigned):
        errors.append("eval baseline identity/digest changed")
    return errors


def validate_p0_verification_manifest(  # noqa: C901 - complete manifest semantics
    value: Any, *, criteria_count: int = 11
) -> list[str]:
    """Validate the selected executable obligation-to-check mapping."""
    if not isinstance(value, dict):
        return ["P0 verification manifest must be an object"]
    required = {
        "schema_version",
        "manifest_id",
        "version",
        "selected",
        "checks",
        "criterion_map",
        "quality_dimension_map",
        "evidence_class_map",
        "annie_obligation_source",
        "annie_obligation_checks",
    }
    errors: list[str] = []
    if set(value) != required:
        errors.append("P0 verification manifest has missing or stale fields")
    if value.get("schema_version") != P0_VERIFICATION_MANIFEST_SCHEMA_VERSION:
        errors.append("P0 verification manifest schema version is unsupported")
    if not isinstance(value.get("manifest_id"), str) or not value.get("manifest_id"):
        errors.append("P0 verification manifest id must be non-empty")
    if type(value.get("version")) is not int or value.get("version", 0) < 1:
        errors.append("P0 verification manifest version must be positive")
    if value.get("selected") is not True:
        errors.append("P0 verification manifest is not selected")
    checks = value.get("checks")
    if not isinstance(checks, dict) or not checks:
        errors.append("P0 verification manifest has no named checks")
        checks = {}
    else:
        for name, argv in checks.items():
            if (
                not isinstance(name, str)
                or not name
                or not isinstance(argv, list)
                or not argv
                or any(not isinstance(item, str) or not item for item in argv)
            ):
                errors.append(f"P0 verification check {name!r} has malformed argv")
    criteria = value.get("criterion_map", {})
    expected_criteria = {f"criterion:{index}" for index in range(1, criteria_count + 1)}
    if not isinstance(criteria, dict) or set(criteria) != expected_criteria:
        errors.append(f"P0 verification manifest must map all {criteria_count} active criteria")
        criteria = {}
    dimensions = value.get("quality_dimension_map", {})
    if not isinstance(dimensions, dict) or set(dimensions) != set(QUALITY_DIMENSION_IDS):
        errors.append("P0 verification manifest must map exactly all six floor dimensions")
        dimensions = {}
    for mapping in (criteria, dimensions):
        for obligation, check_names in mapping.items():
            if not isinstance(check_names, list) or not check_names:
                errors.append(f"{obligation}: no named implementation-targeted check")
            elif any(name not in checks for name in check_names):
                errors.append(f"{obligation}: references an unknown check")
    evidence_classes = value.get("evidence_class_map", {})
    expected_class_ids = expected_criteria | {
        f"quality:{dimension_id}" for dimension_id in QUALITY_DIMENSION_IDS
    }
    if not isinstance(evidence_classes, dict) or set(evidence_classes) != expected_class_ids:
        errors.append("P0 verification manifest evidence classes are incomplete")
    else:
        for obligation_id, evidence_class in evidence_classes.items():
            if evidence_class not in EVIDENCE_CLASSES:
                errors.append(f"{obligation_id}: unknown selected evidence class")
        for dimension_id in (
            "harmful_duplication_avoidance",
            "unnecessary_complexity_avoidance",
        ):
            if evidence_classes.get(f"quality:{dimension_id}") != "judgment-only":
                errors.append(
                    f"quality:{dimension_id}: must use independent judgment-only evidence"
                )
    if value.get("annie_obligation_source") != "selected:annie_findings":
        errors.append("P0 verification manifest Annie source is missing or stale")
    annie_checks = value.get("annie_obligation_checks")
    if not isinstance(annie_checks, list) or not annie_checks:
        errors.append("P0 verification manifest has no Annie obligation checks")
    elif any(name not in checks for name in annie_checks):
        errors.append("P0 verification manifest Annie mapping references an unknown check")
    return errors


def selected_obligation_evidence_class(
    manifest: Any, obligation_id: str, findings: Sequence[Any]
) -> str | None:
    """Resolve the selected class; coverage authors cannot choose a weaker class."""
    if obligation_id.startswith("verification:"):
        return "command-verifiable"
    if isinstance(manifest, dict):
        evidence_classes = manifest.get("evidence_class_map", {})
        if isinstance(evidence_classes, dict):
            selected = evidence_classes.get(obligation_id)
            if selected in EVIDENCE_CLASSES:
                return str(selected)
    if obligation_id.startswith("finding:"):
        finding_id = obligation_id.partition(":")[2]
        for finding in findings:
            if isinstance(finding, dict) and finding.get("id") == finding_id:
                evidence_class = finding.get("evidence_class")
                return str(evidence_class) if evidence_class in EVIDENCE_CLASSES else None
    return None


def validate_target_profile(  # noqa: C901 - typed profile schema validation
    value: Any, *, require_selected: bool = False
) -> list[str]:
    errors: list[str] = []
    if not isinstance(value, dict):
        return ["target profile must be an object"]
    required = {
        "schema_version",
        "status",
        "languages",
        "framework_runtime",
        "target_scope",
        "tooling",
        "verification_commands",
        "conventions",
        "confidence",
        "source_evidence",
        "unverified_reasons",
    }
    if set(value) != required:
        errors.append(f"target profile must contain exactly {sorted(required)}")
    if value.get("schema_version") != TARGET_PROFILE_SCHEMA_VERSION:
        errors.append("unsupported target profile schema version")
    status = value.get("status")
    if status not in {"selected", "unverified"}:
        errors.append("target profile status must be selected or unverified")
    if require_selected and status != "selected":
        errors.append("target profile is not selected; clarification is required")
    for key in ("languages", "framework_runtime", "target_scope", "verification_commands"):
        field = value.get(key)
        if not isinstance(field, list) or any(
            not isinstance(item, str) or not item for item in field
        ):
            errors.append(f"target profile {key} must be a list of non-empty strings")
    tooling = value.get("tooling")
    required_tooling = {"package", "build", "test", "lint", "type"}
    if not isinstance(tooling, dict) or set(tooling) != required_tooling:
        errors.append("target profile tooling must contain exactly package/build/test/lint/type")
    else:
        for field in tooling.values():
            if not isinstance(field, list) or any(
                not isinstance(item, str) or not item for item in field
            ):
                errors.append("target profile tooling values must be lists of non-empty strings")
    conventions = value.get("conventions")
    if not isinstance(conventions, list):
        errors.append("target profile conventions must be a list")
    else:
        for index, convention in enumerate(conventions):
            if not isinstance(convention, dict) or set(convention) != {
                "name",
                "value",
                "source_evidence",
            }:
                errors.append(f"target profile convention {index} has no complete source evidence")
            elif not all(
                isinstance(convention[key], str) and convention[key] for key in convention
            ):
                errors.append(f"target profile convention {index} fields must be non-empty strings")
    if value.get("confidence") not in {"CERTAIN", "PROBABLE", "POSSIBLE", "UNCERTAIN"}:
        errors.append("target profile confidence must use the canonical taxonomy")
    evidence = value.get("source_evidence")
    if not isinstance(evidence, list) or any(
        not isinstance(item, str) or not item for item in evidence
    ):
        errors.append("target profile source_evidence must be a list of non-empty strings")
    reasons = value.get("unverified_reasons")
    if not isinstance(reasons, list) or any(
        not isinstance(item, str) or not item for item in reasons
    ):
        errors.append("target profile unverified_reasons must be a list of non-empty strings")
    if status == "selected" and reasons:
        errors.append("a selected target profile cannot retain unverified reasons")
    return errors


# ── Shared verification-command vocabulary ───────────────────────────────────
# ONE definition, so the advisory discovery in the code playbook
# (``playbooks/code.py::_discover_repo_commands``) and the LOAD-BEARING profile
# selection below cannot drift apart. They previously carried two different word
# lists: a repo whose only gate was ``make ci`` was visible to the advisory path
# but invisible to the profile, yielding a spurious "no project-native
# verification command was evidenced" clarification interrupt.
#
# Semantics are deliberately SUBSTRING for the historical tokens (matching the
# profile's prior behaviour, so nothing that matched before stops matching), with
# word boundaries only where a substring would over-match — ``ci`` inside
# "capacity" being the motivating case. This is a keyword heuristic and therefore
# still a knowledge constraint; the scalable replacement is to have the model read
# the manifests and name the verification commands with cited evidence, keeping
# this regex as the deterministic fallback.
VERIFICATION_COMMAND_HINT_RE = re.compile(
    r"test|check|lint|type|build|verify|eval|tsc|mypy|ruff|eslint|pytest|"
    r"vitest|jest|pyright|flake8|coverage|\bci\b|\bfmt\b|\bsmoke\b",
    re.IGNORECASE,
)


def _declared_commands(  # noqa: C901 - evidence extraction across native manifests
    root: Path,
) -> tuple[list[str], list[str], list[str]]:
    commands: list[str] = []
    tooling: list[str] = []
    evidence: list[str] = []
    makefile = root / "Makefile"
    if makefile.is_file():
        text = makefile.read_text(encoding="utf-8", errors="ignore")
        for target in re.findall(r"(?m)^([A-Za-z0-9][\w.-]*)\s*:(?!=)", text):
            if VERIFICATION_COMMAND_HINT_RE.search(target):
                commands.append(f"make {target}")
        tooling.append("make")
        evidence.append("Makefile targets")
    package_json = root / "package.json"
    if package_json.is_file():
        try:
            package = json.loads(package_json.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            package = {}
        scripts = package.get("scripts", {}) if isinstance(package, dict) else {}
        manager = next(
            (
                command
                for lockfile, command in (
                    ("bun.lock", "bun"),
                    ("bun.lockb", "bun"),
                    ("pnpm-lock.yaml", "pnpm"),
                    ("package-lock.json", "npm"),
                    ("yarn.lock", "yarn"),
                )
                if (root / lockfile).is_file()
            ),
            "",
        )
        if isinstance(scripts, dict) and manager:
            for name in scripts:
                if VERIFICATION_COMMAND_HINT_RE.search(str(name)):
                    commands.append(f"{manager} run {name}")
            evidence.append(f"package.json scripts with selected {manager} lockfile")
        elif isinstance(scripts, dict) and scripts:
            evidence.append("package.json scripts found but package manager is ambiguous")
    return sorted(set(commands)), sorted(set(tooling)), evidence


def detect_target_profile(  # noqa: C901 - multi-ecosystem evidence detection
    project_root: str,
    *,
    explicit_profile: Any = None,
    selected_language: str = "",
    target_scope: Sequence[str] = (),
) -> dict[str, Any]:
    """Detect an evidence-grounded open-vocabulary profile or return unverified.

    An explicit profile is schema-validated and round-tripped unchanged. Repository
    detection does not choose a Python/TypeScript fallback: every detected language
    comes from a manifest/file, and ambiguous polyglot targets remain unverified unless
    the selected IDEAL_STATE explicitly names the intended languages.
    """
    if explicit_profile is not None:
        candidate = deepcopy(explicit_profile)
        errors = validate_target_profile(candidate, require_selected=True)
        if errors:
            return {
                "schema_version": TARGET_PROFILE_SCHEMA_VERSION,
                "status": "unverified",
                "languages": [],
                "framework_runtime": [],
                "target_scope": list(target_scope),
                "tooling": {},
                "verification_commands": [],
                "conventions": [],
                "confidence": "UNCERTAIN",
                "source_evidence": [],
                "unverified_reasons": errors,
            }
        return cast(dict[str, Any], candidate)

    root = Path(project_root) if project_root else Path()
    languages: list[str] = []
    source_evidence: list[str] = []
    tooling: dict[str, list[str]] = {"package": [], "build": [], "test": [], "lint": [], "type": []}
    verification_commands: list[str] = []
    framework_runtime: list[str] = []
    conventions: list[dict[str, str]] = []
    if project_root and root.is_dir():
        signals = (
            ("Python", "pyproject.toml"),
            ("JavaScript/TypeScript", "package.json"),
            ("Go", "go.mod"),
            ("Rust", "Cargo.toml"),
            ("Java", "pom.xml"),
            ("Java", "build.gradle"),
            ("C#", "*.csproj"),
        )
        for language, signal in signals:
            found = (
                list(root.glob(signal))
                if "*" in signal
                else ([root / signal] if (root / signal).is_file() else [])
            )
            if found and language not in languages:
                languages.append(language)
                source_evidence.append(f"{found[0].relative_to(root)} identifies {language}")
        lock_tools = (
            ("uv.lock", "uv"),
            ("bun.lock", "bun"),
            ("bun.lockb", "bun"),
            ("pnpm-lock.yaml", "pnpm"),
            ("package-lock.json", "npm"),
            ("yarn.lock", "yarn"),
        )
        for filename, tool in lock_tools:
            if (root / filename).is_file():
                tooling["package"].append(tool)
                source_evidence.append(f"{filename} selects {tool}")
        verification_commands, build_tools, command_evidence = _declared_commands(root)
        tooling["build"].extend(build_tools)
        source_evidence.extend(command_evidence)
        for command in verification_commands:
            lowered = command.lower()
            if "lint" in lowered:
                tooling["lint"].append(command)
            if "type" in lowered or "mypy" in lowered or "tsc" in lowered:
                tooling["type"].append(command)
            if "test" in lowered or "check" in lowered or "eval" in lowered:
                tooling["test"].append(command)
        pyproject = root / "pyproject.toml"
        if pyproject.is_file():
            text = pyproject.read_text(encoding="utf-8", errors="ignore").lower()
            for runtime in ("fastapi", "flask", "django", "starlette"):
                if runtime in text:
                    framework_runtime.append(runtime)
        package_json = root / "package.json"
        if package_json.is_file():
            text = package_json.read_text(encoding="utf-8", errors="ignore").lower()
            for runtime in ("lit", "react", "vue", "express", "fastify", "next"):
                if f'"{runtime}"' in text:
                    framework_runtime.append(runtime)
        if (root / "pyproject.toml").is_file():
            conventions.append(
                {
                    "name": "python-tool-configuration",
                    "value": "follow pyproject.toml",
                    "source_evidence": "pyproject.toml",
                }
            )
        if (root / ".prettierrc").is_file() or (root / "eslint.config.js").is_file():
            source = ".prettierrc" if (root / ".prettierrc").is_file() else "eslint.config.js"
            conventions.append(
                {
                    "name": "typescript-format-lint",
                    "value": f"follow {source}",
                    "source_evidence": source,
                }
            )

    selected_text = selected_language.lower()

    def explicitly_names(language: str) -> bool:
        aliases = {language.lower(), language.lower().split("/")[0]}
        if language == "JavaScript/TypeScript":
            aliases.update({"javascript", "typescript", "js/ts"})
        if language == "C#":
            aliases.add("csharp")
        return any(alias in selected_text for alias in aliases)

    explicitly_selected = [language for language in languages if explicitly_names(language)]
    reasons: list[str] = []
    if not project_root or not root.is_dir() or not any(root.iterdir()):
        reasons.append(
            "greenfield target lacks evidence; language/framework/tooling clarification required"
        )
    elif len(languages) > 1 and not explicitly_selected:
        reasons.append("polyglot target is ambiguous; select the intended language(s) and scope")
    elif not languages:
        reasons.append(
            "no language evidence found; an explicit open-vocabulary profile is required"
        )
    if selected_language and explicitly_selected:
        languages = explicitly_selected
        source_evidence.append("selected IDEAL_STATE language narrows repository evidence")
    commands = sorted(set(verification_commands))
    if not commands:
        reasons.append("no project-native verification command was evidenced")
    if not framework_runtime:
        framework_runtime = ["framework-free"]
        source_evidence.append(
            "no framework dependency was evidenced; explicit framework-free profile"
        )
    status = "selected" if not reasons else "unverified"
    return {
        "schema_version": TARGET_PROFILE_SCHEMA_VERSION,
        "status": status,
        "languages": languages,
        "framework_runtime": sorted(set(framework_runtime)),
        "target_scope": list(target_scope) or (["."] if project_root else []),
        "tooling": {key: sorted(set(value)) for key, value in tooling.items()},
        "verification_commands": commands,
        "conventions": conventions,
        "confidence": "PROBABLE" if status == "selected" else "UNCERTAIN",
        "source_evidence": source_evidence,
        "unverified_reasons": reasons,
    }


def new_gate_challenge() -> str:
    """Create a one-time gate challenge."""
    return secrets.token_urlsafe(32)


def trusted_human_signing_key(
    env: Mapping[str, str] | None = None,
) -> bytes | None:
    """Load the trusted-questionnaire key without exposing it to an agent task."""
    raw = (env if env is not None else os.environ).get("PENNY_APPROVAL_HMAC_KEY", "")
    if not isinstance(raw, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", raw):
        return None
    return bytes.fromhex(raw)


def sign_trusted_human_event(event: Mapping[str, Any], key: bytes) -> str:
    """Sign a trusted UI event. The signer key must remain outside agent capability."""
    unsigned = {key_name: value for key_name, value in event.items() if key_name != "signature"}
    return hmac.new(key, canonical_json(unsigned), hashlib.sha256).hexdigest()


def validate_questionnaire_transport(value: Any, *, artifact_ref: ArtifactRef) -> list[str]:
    """Validate exact engine-rendered structural questions and their artifact binding."""
    required = {
        "gate_id",
        "challenge",
        "artifact_ref",
        "questions",
        "rendered_questions_digest",
        "transport",
    }
    if not isinstance(value, dict) or set(value) != required:
        return ["questionnaire transport has missing or stale fields"]
    errors: list[str] = []
    if not isinstance(value.get("gate_id"), str) or not value["gate_id"]:
        errors.append("questionnaire transport gate id is missing")
    if not isinstance(value.get("challenge"), str) or len(value["challenge"]) < 32:
        errors.append("questionnaire transport challenge is missing or weak")
    try:
        supplied_ref = ArtifactRef.from_dict(value.get("artifact_ref", {}))
    except ArtifactValidationError as exc:
        errors.append(str(exc))
        supplied_ref = None
    if supplied_ref != artifact_ref:
        errors.append("questionnaire transport is bound to a different artifact")
    questions = value.get("questions")
    if (
        not isinstance(questions, list)
        or not questions
        or any(not isinstance(question, dict) for question in questions)
    ):
        errors.append("questionnaire transport questions are malformed")
    elif value.get("rendered_questions_digest") != sha256_json(questions):
        errors.append("questionnaire transport rendered-question digest changed")
    if value.get("transport") != "structural-json-terminal-safe":
        errors.append("questionnaire transport mode is unsupported")
    return errors


def validate_trusted_human_event(  # noqa: C901 - complete signed-event validation
    event: Any,
    *,
    run_id: str,
    gate_id: str,
    challenge: str,
    artifact_ref: ArtifactRef,
    questionnaire_transport_ref: ArtifactRef,
    rendered_questions_digest: str,
    key: bytes | None,
) -> tuple[bool, str]:
    required = frozenset(
        {
            "schema_version",
            "origin",
            "run_id",
            "gate_id",
            "challenge",
            "artifact_ref",
            "questionnaire_transport_ref",
            "rendered_questions_digest",
            "actor",
            "timestamp",
            "decision",
            "signature",
        }
    )
    if not isinstance(event, dict):
        return False, "plain caller/user_response text is not a trusted human approval event"
    event_keys = frozenset(event)
    if not required.issubset(event_keys) or event_keys - required not in {
        frozenset(),
        frozenset({"response"}),
    }:
        return False, "trusted human event has missing or stale fields"
    if event.get("schema_version") != APPROVAL_SCHEMA_VERSION:
        return False, "unsupported trusted human event schema version"
    if event.get("origin") != "trusted-human-ui":
        return False, "approval origin is not the trusted human UI"
    if event.get("run_id") != run_id or event.get("gate_id") != gate_id:
        return False, "approval is bound to the wrong run or gate"
    if not hmac.compare_digest(str(event.get("challenge", "")), challenge):
        return False, "approval challenge is stale or replayed"
    try:
        supplied_ref = ArtifactRef.from_dict(event.get("artifact_ref", {}))
        supplied_transport_ref = ArtifactRef.from_dict(event.get("questionnaire_transport_ref", {}))
        _parse_utc(event.get("timestamp"), "approval timestamp")
    except ArtifactValidationError as exc:
        return False, str(exc)
    if supplied_ref != artifact_ref:
        return False, "approval is bound to a stale artifact version or digest"
    if supplied_transport_ref != questionnaire_transport_ref:
        return False, "approval is bound to a stale questionnaire transport"
    if (
        not isinstance(event.get("rendered_questions_digest"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", event["rendered_questions_digest"])
        or event["rendered_questions_digest"] != rendered_questions_digest
    ):
        return False, "approval is not bound to the exact rendered structural content"
    if not isinstance(event.get("actor"), str) or not event["actor"]:
        return False, "approval actor is missing"
    if event.get("decision") not in {"approve", "refine", "deny", "accept-risk"}:
        return False, "approval decision is unknown"
    if "response" in event and (
        not isinstance(event["response"], str) or not event["response"].strip()
    ):
        return False, "trusted human response is empty"
    if not key:
        return False, "trusted UI verification key is unavailable; remain awaiting human input"
    expected = sign_trusted_human_event(event, key)
    if not hmac.compare_digest(str(event.get("signature", "")), expected):
        return False, "trusted human event signature is invalid"
    return True, ""


def validate_residual_risk_acceptance(value: Any, *, finding_id: str, run_id: str) -> list[str]:
    required = {
        "finding_id",
        "scope",
        "rationale",
        "accepter",
        "timestamp",
        "run_id",
        "authorization_ref",
    }
    if not isinstance(value, dict) or set(value) != required:
        return [f"residual-risk acceptance must contain exactly {sorted(required)}"]
    errors: list[str] = []
    if value.get("finding_id") != finding_id:
        errors.append("residual-risk acceptance is bound to the wrong finding")
    if value.get("run_id") != run_id:
        errors.append("residual-risk acceptance is bound to the wrong run")
    for field in ("scope", "rationale", "accepter", "authorization_ref"):
        if not isinstance(value.get(field), str) or not value[field].strip():
            errors.append(f"residual-risk acceptance {field} must be non-empty")
    try:
        _parse_utc(value.get("timestamp"), "residual-risk timestamp")
    except ArtifactValidationError as exc:
        errors.append(str(exc))
    return errors


def validate_finding_dispositions(  # noqa: C901 - complete disposition validation
    findings: Any, *, run_id: str
) -> list[str]:
    if not isinstance(findings, list):
        return ["Annie findings must be a list"]
    errors: list[str] = []
    seen: set[str] = set()
    for index, finding in enumerate(findings):
        path = f"findings[{index}]"
        if not isinstance(finding, dict):
            errors.append(f"{path} must be an object")
            continue
        finding_id = finding.get("id")
        if not isinstance(finding_id, str) or not finding_id:
            errors.append(f"{path}.id must be non-empty")
            continue
        if finding_id in seen:
            errors.append(f"finding {finding_id!r} has more than one state")
        seen.add(finding_id)
        if finding.get("evidence_class") not in EVIDENCE_CLASSES:
            errors.append(f"finding {finding_id!r} has no permitted selected evidence class")
        state = finding.get("state")
        if state not in FINDING_STATES:
            errors.append(f"finding {finding_id!r} has unknown state {state!r}")
        if state == "remediated" and not finding.get("evidence_refs"):
            errors.append(f"remediated finding {finding_id!r} has no evidence")
        if state == "not_applicable" and not str(finding.get("rationale", "")).strip():
            errors.append(f"not-applicable finding {finding_id!r} has no rationale")
        if state == "human_accepted_residual_risk":
            errors.extend(
                validate_residual_risk_acceptance(
                    finding.get("acceptance"), finding_id=finding_id, run_id=run_id
                )
            )
        if state == "unresolved":
            errors.append(f"finding {finding_id!r} remains unresolved")
    return errors


def expected_obligation_ids(
    criteria_count: int,
    finding_ids: Sequence[str],
    verification_ids: Sequence[str] = (),
) -> set[str]:
    return {
        *(f"criterion:{index}" for index in range(1, criteria_count + 1)),
        *(f"quality:{dimension_id}" for dimension_id in QUALITY_DIMENSION_IDS),
        *(f"finding:{finding_id}" for finding_id in finding_ids),
        *(f"verification:{verification_id}" for verification_id in verification_ids),
    }


def validate_coverage_map(  # noqa: C901 - typed obligation/evidence validation
    value: Any,
    *,
    run_id: str,
    expected_ids: set[str],
    evidence_resolver: Callable[[str], tuple[str, Any] | None],
    receipt_validator: Callable[[Any, str], tuple[bool, str]],
    independence_validator: Callable[[Any, str], tuple[bool, str]],
    evidence_class_resolver: Callable[[str], str | None] | None = None,
) -> list[str]:
    if not isinstance(value, dict):
        return ["coverage map must be an object"]
    if set(value) != {"schema_version", "run_id", "obligations", "selected_refs"}:
        return ["coverage map has missing or stale fields"]
    errors: list[str] = []
    if value.get("schema_version") != COVERAGE_MAP_SCHEMA_VERSION:
        errors.append("unsupported coverage map schema version")
    if value.get("run_id") != run_id:
        errors.append("coverage map is bound to the wrong run")
    if not isinstance(value.get("selected_refs"), dict):
        errors.append("coverage map selected_refs must be an object")
    obligations = value.get("obligations")
    if not isinstance(obligations, list):
        return errors + ["coverage map obligations must be a list"]
    actual_ids: list[str] = []
    for index, obligation in enumerate(obligations):
        path = f"obligations[{index}]"
        if not isinstance(obligation, dict) or set(obligation) != {
            "id",
            "evidence_class",
            "status",
            "evidence_refs",
        }:
            errors.append(f"{path} has missing or stale fields")
            continue
        obligation_id = obligation.get("id")
        if not isinstance(obligation_id, str) or not obligation_id:
            errors.append(f"{path}.id must be non-empty")
            continue
        actual_ids.append(obligation_id)
        evidence_class = obligation.get("evidence_class")
        if evidence_class not in EVIDENCE_CLASSES:
            errors.append(f"{obligation_id}: unknown evidence class")
            continue
        selected_class = (
            evidence_class_resolver(obligation_id) if evidence_class_resolver else evidence_class
        )
        if selected_class is None:
            errors.append(f"{obligation_id}: no selected evidence class")
            continue
        if evidence_class != selected_class:
            errors.append(f"{obligation_id}: coverage evidence class differs from selected class")
            continue
        if obligation.get("status") != "satisfied":
            errors.append(f"{obligation_id}: obligation is unresolved")
            continue
        refs = obligation.get("evidence_refs")
        if not isinstance(refs, list) or not refs:
            errors.append(f"{obligation_id}: no durable evidence references")
            continue
        for evidence_id in refs:
            if not isinstance(evidence_id, str):
                errors.append(f"{obligation_id}: evidence reference is not a string")
                continue
            resolved = evidence_resolver(evidence_id)
            if resolved is None:
                errors.append(f"{obligation_id}: missing evidence {evidence_id!r}")
                continue
            kind, payload = resolved
            if evidence_class == "command-verifiable":
                if kind != "execution_receipt":
                    errors.append(f"{obligation_id}: wrong evidence class {kind!r}")
                    continue
                valid, reason = receipt_validator(payload, obligation_id)
            else:
                if kind not in {"security_disposition", "annie_disposition"}:
                    errors.append(f"{obligation_id}: wrong disposition class {kind!r}")
                    continue
                valid, reason = independence_validator(payload, obligation_id)
            if not valid:
                errors.append(f"{obligation_id}: {reason}")
    if len(actual_ids) != len(set(actual_ids)):
        errors.append("coverage map contains duplicate/conflicting obligations")
    missing = expected_ids - set(actual_ids)
    extra = set(actual_ids) - expected_ids
    if missing:
        errors.append(f"coverage map is incomplete: missing {sorted(missing)}")
    if extra:
        errors.append(f"coverage map has unknown obligations: {sorted(extra)}")
    return errors


def validate_p0_completion(  # noqa: C901 - central fail-closed completion gate
    registry: ArtifactRegistry,
    *,
    criteria_count: int,
    project_root: str,
) -> list[str]:
    """Apply the single fail-closed P0 completion predicate to selected artifacts."""
    from .execution_receipts import (
        receipt_signing_key,
        validate_execution_receipt,
        validate_independent_disposition,
    )

    errors: list[str] = []
    required_kinds = {
        "scope_leak_manifest",
        "worktree_preservation",
        "quality_floor",
        "quality_floor_status",
        "target_profile",
        "echo_exploration",
        "annie_findings",
        "ideal_state_revision",
        "criteria_review",
        "criteria_approval",
        "piper_plan",
        "plan_approval",
        "questionnaire_transport",
        "implementation",
        "verification_result",
        "learning_result",
        "coverage_map",
        "p0_verification_manifest",
        "eval_baseline",
        "contract_drift_matrix",
    }
    selections = registry.selections()
    missing = required_kinds - set(selections)
    if missing:
        errors.append(f"required P0 artifacts are missing: {sorted(missing)}")
        return errors

    recovered = {kind: registry.get(reference) for kind, reference in selections.items()}
    from .scope_preservation import (
        compare_preservation_artifact,
        out_of_scope_dirty_paths,
        validate_scope_manifest,
    )

    scope_manifest = recovered["scope_leak_manifest"].payload
    errors.extend(validate_scope_manifest(scope_manifest))
    preservation = recovered["worktree_preservation"].payload
    if not isinstance(preservation, dict) or preservation.get("status") == "unverified":
        errors.append("dirty-worktree preservation evidence is unverified")
    elif preservation.get("schema_version") != 1 or not preservation.get("digest"):
        errors.append("dirty-worktree preservation artifact is malformed or lacks integrity")
    elif not preservation.get("artifact_directory"):
        errors.append("dirty-worktree preservation artifact has no direct-comparison snapshot")
    else:
        try:
            errors.extend(
                compare_preservation_artifact(project_root, str(preservation["artifact_directory"]))
            )
            expected_report_only = preservation.get("report_only_paths")
            if not isinstance(expected_report_only, list):
                expected_report_only = [
                    item.get("path")
                    for item in preservation.get("paths", [])
                    if isinstance(item, dict) and isinstance(item.get("path"), str)
                ]
            current_report_only = out_of_scope_dirty_paths(project_root, scope_manifest)
            if sorted(expected_report_only) != current_report_only:
                errors.append(
                    "out-of-scope dirty path set changed: "
                    f"expected={sorted(expected_report_only)!r} current={current_report_only!r}"
                )
        except (OSError, ValueError, json.JSONDecodeError, subprocess.SubprocessError) as exc:
            errors.append(f"dirty-worktree preservation comparison failed: {exc}")
    baseline = recovered["eval_baseline"].payload
    if not isinstance(baseline, dict) or baseline.get("status") == "unverified":
        errors.append("immutable pre-edit full-eval baseline is unverified")
    else:
        errors.extend(validate_eval_baseline(baseline))
    verification_manifest = recovered["p0_verification_manifest"].payload
    errors.extend(
        validate_p0_verification_manifest(verification_manifest, criteria_count=criteria_count)
    )
    verification_tiers: list[dict[str, str]] = []
    checks = (
        verification_manifest.get("checks", {}) if isinstance(verification_manifest, dict) else {}
    )

    def manifest_command(argv: list[str]) -> str:
        if len(argv) == 3 and argv[0] in {"bash", "sh"} and argv[1] in {"-c", "-lc"}:
            return argv[2]
        return shlex.join(argv)

    if isinstance(checks, dict):
        verification_tiers = [
            {"name": str(name), "command": manifest_command(argv)}
            for name, argv in checks.items()
            if isinstance(name, str)
            and isinstance(argv, list)
            and argv
            and all(isinstance(arg, str) and arg for arg in argv)
        ]
        baseline_argv = baseline.get("command_argv") if isinstance(baseline, dict) else None
        matching_baseline_checks = {
            str(name) for name, argv in checks.items() if argv == baseline_argv
        }
        if not matching_baseline_checks:
            errors.append("eval baseline command is not selected by the verification manifest")
        regression_checks = verification_manifest.get("quality_dimension_map", {}).get(
            "regression_freedom", []
        )
        if not matching_baseline_checks.intersection(regression_checks):
            errors.append(
                "regression-freedom coverage does not select the baseline full-eval command"
            )
    drift_matrix = recovered["contract_drift_matrix"].payload
    if not isinstance(drift_matrix, dict) or drift_matrix.get("schema_version") != 1:
        errors.append("contract/drift matrix is missing or invalid")
    if isinstance(baseline, dict):
        errors.extend(
            validate_selected_release_input_binding(
                baseline.get("selected_inputs"),
                {
                    "scope_leak_manifest": scope_manifest,
                    "verification_manifest": verification_manifest,
                    "contract_drift_matrix": drift_matrix,
                },
            )
        )
    for full_content_kind, label in (
        ("echo_exploration", "Echo exploration"),
        ("annie_findings", "Annie findings"),
        ("piper_plan", "Piper plan"),
    ):
        payload = recovered[full_content_kind].payload
        if not isinstance(payload, dict) or payload.get("content_status") != "verified":
            errors.append(f"selected {label} does not contain verified full content")

    floor = recovered["quality_floor"].payload
    errors.extend(validate_quality_floor(floor))
    errors.extend(
        validate_target_profile(recovered["target_profile"].payload, require_selected=True)
    )

    verification = recovered["verification_result"].payload
    if not isinstance(verification, dict) or verification.get("passed") is not True:
        errors.append("final verification did not pass")
    elif verification.get("final_battery") is not True:
        errors.append("final verification battery has not passed")
    findings_payload = recovered["annie_findings"].payload
    findings = findings_payload.get("findings", []) if isinstance(findings_payload, dict) else []
    errors.extend(validate_finding_dispositions(findings, run_id=registry.run_id))
    for finding in findings:
        if not isinstance(finding, dict) or finding.get("state") != "human_accepted_residual_risk":
            continue
        acceptance = finding.get("acceptance", {})
        authorization_id = (
            acceptance.get("authorization_ref") if isinstance(acceptance, dict) else None
        )
        raw_authorization = (
            registry.checkpointer.get_artifact(authorization_id)
            if isinstance(authorization_id, str) and authorization_id
            else None
        )
        if raw_authorization is None:
            errors.append(
                f"finding {finding.get('id')!r} has no durable trusted-human authorization"
            )
            continue
        try:
            authorization = ArtifactEnvelope.from_dict(
                raw_authorization, expected_run_id=registry.run_id
            )
        except ArtifactValidationError as exc:
            errors.append(f"finding {finding.get('id')!r} authorization is invalid: {exc}")
            continue
        payload = authorization.payload
        event = payload.get("trusted_event") if isinstance(payload, dict) else None
        recorded = payload.get("acceptance") if isinstance(payload, dict) else None
        expected_record = {
            key: value for key, value in acceptance.items() if key != "authorization_ref"
        }
        event_ref: ArtifactRef | None = None
        transport_ref: ArtifactRef | None = None
        event_envelope: ArtifactEnvelope | None = None
        transport_envelope: ArtifactEnvelope | None = None
        transport: Any = None
        try:
            if isinstance(event, dict):
                event_ref = ArtifactRef.from_dict(event.get("artifact_ref", {}))
                transport_ref = ArtifactRef.from_dict(event.get("questionnaire_transport_ref", {}))
                event_envelope = registry.get(event_ref)
                transport_envelope = registry.get(transport_ref)
                transport = transport_envelope.payload
        except ArtifactValidationError:
            event_ref = None
            transport_ref = None
        valid_event = False
        event_reason = "trusted risk event is missing or malformed"
        event_record = event if isinstance(event, dict) else {}
        if event_ref is not None and transport_ref is not None and isinstance(transport, dict):
            valid_event, event_reason = validate_trusted_human_event(
                event_record,
                run_id=registry.run_id,
                gate_id=f"risk_acceptance:{finding.get('id')}",
                challenge=str(transport.get("challenge", "")),
                artifact_ref=event_ref,
                questionnaire_transport_ref=transport_ref,
                rendered_questions_digest=str(transport.get("rendered_questions_digest", "")),
                key=trusted_human_signing_key(),
            )
        transport_errors = (
            validate_questionnaire_transport(transport, artifact_ref=event_ref)
            if event_ref is not None
            else ["missing approved artifact reference"]
        )
        event_findings = (
            event_envelope.payload.get("findings", [])
            if event_envelope is not None and isinstance(event_envelope.payload, dict)
            else []
        )
        event_finding_ids = {item.get("id") for item in event_findings if isinstance(item, dict)}
        if authorization.kind != "human_risk_acceptance":
            errors.append(
                f"finding {finding.get('id')!r} authorization has the wrong artifact kind"
            )
        elif (
            event_envelope is None
            or event_envelope.kind != "annie_findings"
            or finding.get("id") not in event_finding_ids
        ):
            errors.append(
                f"finding {finding.get('id')!r} authorization is bound to the wrong finding artifact"
            )
        elif (
            transport_envelope is None
            or transport_envelope.kind != "questionnaire_transport"
            or transport_envelope.authority != "trusted-questionnaire-transport"
            or event_ref not in transport_envelope.upstream_refs
            or transport_errors
        ):
            errors.append(f"finding {finding.get('id')!r} authorization transport is not canonical")
        elif recorded != expected_record:
            errors.append(f"finding {finding.get('id')!r} authorization record changed")
        elif (
            event_ref not in authorization.upstream_refs
            or transport_ref not in authorization.upstream_refs
        ):
            errors.append(f"finding {finding.get('id')!r} authorization is not upstream-bound")
        elif not valid_event or event_record.get("decision") != "accept-risk":
            errors.append(
                f"finding {finding.get('id')!r} lacks valid explicit human risk acceptance: "
                f"{event_reason}"
            )
        elif event_record.get("actor") != acceptance.get("accepter") or event_record.get(
            "timestamp"
        ) != acceptance.get("timestamp"):
            errors.append(
                f"finding {finding.get('id')!r} acceptance actor/time is not authoritative"
            )
    finding_ids: list[str] = [
        str(finding["id"])
        for finding in findings
        if isinstance(finding, dict) and isinstance(finding.get("id"), str)
    ]

    def resolve(evidence_id: str) -> tuple[str, Any] | None:
        raw = registry.checkpointer.get_artifact(evidence_id)
        if raw is None:
            return None
        try:
            envelope = ArtifactEnvelope.from_dict(raw, expected_run_id=registry.run_id)
        except ArtifactValidationError:
            return None
        return envelope.kind, envelope.payload

    receipt_key = receipt_signing_key()

    def receipt_validator(payload: Any, obligation_id: str) -> tuple[bool, str]:
        return validate_execution_receipt(
            payload,
            run_id=registry.run_id,
            obligation_id=obligation_id,
            key=receipt_key,
            allowed_working_root=project_root or None,
        )

    def independence_validator(payload: Any, obligation_id: str) -> tuple[bool, str]:
        valid, reason = validate_independent_disposition(
            payload, run_id=registry.run_id, obligation_id=obligation_id
        )
        if not valid:
            return valid, reason
        artifact_id = f"disposition:{sha256_json(payload)}"
        raw = registry.checkpointer.get_artifact(artifact_id)
        if raw is None:
            return False, "independent-review disposition lacks canonical trusted provenance"
        try:
            envelope = ArtifactEnvelope.from_dict(raw, expected_run_id=registry.run_id)
        except ArtifactValidationError:
            return False, "independent-review disposition provenance artifact is invalid"
        if envelope.authority != "trusted-invocation-provenance":
            return False, "independent-review disposition authority is not engine-owned"
        return True, ""

    coverage = recovered["coverage_map"].payload
    errors.extend(
        validate_quality_floor_status(
            recovered["quality_floor_status"].payload,
            floor_ref=selections["quality_floor"],
            coverage_ref=selections["coverage_map"],
            coverage=coverage,
        )
    )
    errors.extend(
        validate_coverage_map(
            coverage,
            run_id=registry.run_id,
            expected_ids=expected_obligation_ids(
                criteria_count,
                finding_ids,
                [str(tier["name"]) for tier in verification_tiers],
            ),
            evidence_resolver=resolve,
            receipt_validator=receipt_validator,
            independence_validator=independence_validator,
            evidence_class_resolver=lambda obligation_id: selected_obligation_evidence_class(
                verification_manifest, obligation_id, findings
            ),
        )
    )
    tier_commands = {str(tier["name"]): str(tier["command"]) for tier in verification_tiers}
    obligations = coverage.get("obligations", []) if isinstance(coverage, dict) else []
    obligations_by_id = {
        str(obligation.get("id")): obligation
        for obligation in obligations
        if isinstance(obligation, dict)
    }

    def receipt_command(obligation_id: str) -> str:
        obligation = obligations_by_id.get(obligation_id, {})
        if (
            not isinstance(obligation, dict)
            or obligation.get("evidence_class") != "command-verifiable"
        ):
            return ""
        refs = obligation.get("evidence_refs", [])
        resolved = resolve(str(refs[0])) if isinstance(refs, list) and refs else None
        receipt = resolved[1] if resolved and resolved[0] == "execution_receipt" else {}
        argv = receipt.get("argv", []) if isinstance(receipt, dict) else []
        if (
            not isinstance(argv, list)
            or not argv
            or any(not isinstance(item, str) for item in argv)
        ):
            return ""
        if len(argv) == 3 and argv[0] in {"bash", "sh"} and argv[1] in {"-c", "-lc"}:
            return str(argv[2])
        return shlex.join(str(item) for item in argv)

    for tier_name, expected_command in tier_commands.items():
        obligation_id = f"verification:{tier_name}"
        if receipt_command(obligation_id) != expected_command:
            errors.append(f"{obligation_id}: receipt does not prove the selected manifest command")

    def require_mapped_command(obligation_id: str, check_names: Any) -> None:
        obligation = obligations_by_id.get(obligation_id, {})
        if (
            not isinstance(obligation, dict)
            or obligation.get("evidence_class") != "command-verifiable"
        ):
            return
        allowed = {
            tier_commands[name]
            for name in check_names
            if isinstance(name, str) and name in tier_commands
        }
        actual = receipt_command(obligation_id)
        if actual not in allowed:
            errors.append(
                f"{obligation_id}: receipt command is not authorized by its selected manifest mapping"
            )

    if isinstance(verification_manifest, dict):
        criterion_map = verification_manifest.get("criterion_map", {})
        quality_map = verification_manifest.get("quality_dimension_map", {})
        annie_checks = verification_manifest.get("annie_obligation_checks", [])
        if isinstance(criterion_map, dict):
            for obligation_id, check_names in criterion_map.items():
                require_mapped_command(str(obligation_id), check_names)
        if isinstance(quality_map, dict):
            for dimension_id, check_names in quality_map.items():
                require_mapped_command(f"quality:{dimension_id}", check_names)
        for finding_id in finding_ids:
            require_mapped_command(f"finding:{finding_id}", annie_checks)

    plan_content = recovered["piper_plan"].payload.get("content", "")
    for finding_id in finding_ids:
        if finding_id not in str(plan_content):
            errors.append(f"Piper plan omitted Annie finding {finding_id!r}")

    for approval_kind, upstream_kind in (
        ("criteria_approval", "ideal_state_revision"),
        ("plan_approval", "piper_plan"),
    ):
        approval = recovered[approval_kind]
        selected_upstream = selections[upstream_kind]
        if selected_upstream not in approval.upstream_refs:
            errors.append(f"{approval_kind} is not bound to the exact selected {upstream_kind}")
        transport_refs = [
            reference
            for reference in approval.upstream_refs
            if reference.kind == "questionnaire_transport"
        ]
        if len(transport_refs) != 1:
            errors.append(f"{approval_kind} is not bound to one durable questionnaire transport")
            continue
        try:
            transport_envelope = registry.get(transport_refs[0])
            transport = transport_envelope.payload
        except ArtifactValidationError as exc:
            errors.append(f"{approval_kind} questionnaire transport is invalid: {exc}")
            continue
        expected_gate = "criteria_gate" if approval_kind == "criteria_approval" else "plan_gate"
        transport_errors = validate_questionnaire_transport(
            transport, artifact_ref=selected_upstream
        )
        if (
            transport_envelope.authority != "trusted-questionnaire-transport"
            or selected_upstream not in transport_envelope.upstream_refs
            or transport_errors
            or transport.get("gate_id") != expected_gate
        ):
            errors.append(f"{approval_kind} questionnaire transport is incomplete or stale")
            continue
        valid_event, event_reason = validate_trusted_human_event(
            approval.payload,
            run_id=registry.run_id,
            gate_id=expected_gate,
            challenge=str(transport.get("challenge", "")),
            artifact_ref=selected_upstream,
            questionnaire_transport_ref=transport_refs[0],
            rendered_questions_digest=str(transport.get("rendered_questions_digest", "")),
            key=trusted_human_signing_key(),
        )
        if not valid_event:
            errors.append(f"{approval_kind} trusted event is invalid: {event_reason}")
        elif (
            not isinstance(approval.payload, dict) or approval.payload.get("decision") != "approve"
        ):
            errors.append(f"{approval_kind} does not record an explicit approve decision")

    anchor_kinds = {"quality_floor", "target_profile", "ideal_state_revision", "piper_plan"}
    anchor_refs = {kind: selections[kind].to_dict() for kind in anchor_kinds}
    for kind in (
        "implementation",
        "verification_result",
        "learning_result",
        "coverage_map",
    ):
        payload = recovered[kind].payload
        selected_refs = payload.get("selected_refs") if isinstance(payload, dict) else None
        if selected_refs != anchor_refs:
            errors.append(f"{kind} does not reference the same selected upstream versions")
    for kind in ("echo_exploration", "annie_findings", "criteria_review", "piper_plan"):
        payload = recovered[kind].payload
        selected_refs = payload.get("selected_refs") if isinstance(payload, dict) else None
        floor_ref = selected_refs.get("quality_floor") if isinstance(selected_refs, dict) else None
        if floor_ref != selections["quality_floor"].to_dict():
            errors.append(f"{kind} does not reference the selected quality-floor version")
    return errors
