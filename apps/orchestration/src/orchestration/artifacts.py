"""Generic immutable workflow artifact protocol and content-addressed store.

The artifact plane is deliberately separate from both orchestration checkpoints and
MemPalace.  It owns exact bytes, immutable metadata, lineage, and compare-and-swap
selection; it does not own FSM transitions.  Raw content is always owner-only, is
never logged, and is never promoted to durable memory automatically.  Retention is
an explicit run/product policy outside this foundational store.

Protocol versions implemented here:

* :class:`ArtifactRef` and :class:`ArtifactEnvelope`: schema version 1;
* :class:`ResultProtocolV2`: result protocol version 2;
* :class:`InputArtifactsV1`: directive input-artifacts version 1.

Unknown fields and unsupported versions fail closed.  Artifact kinds are open-ended:
the named constants distinguish the protocol's foundational kinds without creating a
domain-specific master taxonomy.
"""

from __future__ import annotations

import errno
import hashlib
import json
import logging
import os
import re
import secrets
import sqlite3
import stat
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, ClassVar, Final

ARTIFACT_SCHEMA_VERSION: Final = 1
OUTPUT_ARTIFACT_SCHEMA_VERSION: Final = 1
RESULT_PROTOCOL_VERSION: Final = 2
INPUT_ARTIFACTS_SCHEMA_VERSION: Final = 1

KIND_AGENT_OUTPUT: Final = "agent-output"
KIND_AGENT_TRANSCRIPT: Final = "agent-transcript"
KIND_EXECUTION_RECEIPT: Final = "execution-receipt"
KIND_SUMMARY: Final = "summary"

DEFAULT_MATERIALIZATION_TTL_SECONDS: Final = 15 * 60
ARTIFACT_ROOT_ENV: Final = "PENNY_ARTIFACT_ROOT"
XDG_STATE_HOME_ENV: Final = "XDG_STATE_HOME"

_OBJECT_URI_PREFIX: Final = "artifact://sha256/"
_ARTIFACT_ID_PREFIX: Final = "art_"
_BRANCH_NONE: Final = ""
_DIGEST_RE: Final = re.compile(r"^[0-9a-f]{64}$")
_ARTIFACT_ID_RE: Final = re.compile(r"^art_[0-9a-f]{64}$")
_KIND_RE: Final = re.compile(r"^[a-z][a-z0-9-]*$")
_MATERIALIZATION_ID_RE: Final = re.compile(r"^mat_[0-9a-f]{32}$")
_NO_EXPECTED_BRANCH: Final = object()
_LOG = logging.getLogger(__name__)

_MANIFEST_SCHEMA = """
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id       TEXT PRIMARY KEY,
  schema_version    INTEGER NOT NULL,
  run_id            TEXT NOT NULL,
  phase             TEXT NOT NULL,
  branch_key        TEXT NOT NULL,
  kind              TEXT NOT NULL,
  operation_id      TEXT NOT NULL,
  version           INTEGER NOT NULL,
  producer          TEXT NOT NULL,
  media_type        TEXT NOT NULL,
  byte_length       INTEGER NOT NULL,
  content_digest    TEXT NOT NULL,
  store_ref         TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  envelope_json     TEXT NOT NULL,
  UNIQUE (run_id, phase, branch_key, kind, operation_id, version)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run
  ON artifacts(run_id, phase, branch_key, kind, version);

CREATE TABLE IF NOT EXISTS artifact_selections (
  run_id            TEXT NOT NULL,
  phase             TEXT NOT NULL,
  branch_key        TEXT NOT NULL,
  kind              TEXT NOT NULL,
  artifact_id       TEXT NOT NULL,
  version           INTEGER NOT NULL,
  selected_at       TEXT NOT NULL,
  PRIMARY KEY (run_id, phase, branch_key, kind),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id)
);

CREATE TABLE IF NOT EXISTS artifact_materializations (
  materialization_id TEXT PRIMARY KEY,
  artifact_id        TEXT NOT NULL,
  path_name          TEXT NOT NULL UNIQUE,
  range_start        INTEGER NOT NULL,
  range_end          INTEGER NOT NULL,
  expires_at         TEXT NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id)
);
CREATE INDEX IF NOT EXISTS idx_artifact_materializations_expiry
  ON artifact_materializations(expires_at);

CREATE TRIGGER IF NOT EXISTS artifacts_no_update
BEFORE UPDATE ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifact rows are immutable');
END;

CREATE TRIGGER IF NOT EXISTS artifacts_no_delete
BEFORE DELETE ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifact rows are immutable');
END;
"""


class ArtifactError(RuntimeError):
    """Base class for artifact-plane failures."""


class ArtifactValidationError(ArtifactError, ValueError):
    """A protocol value or caller expectation is invalid."""


class ArtifactPathError(ArtifactError, PermissionError):
    """A store path is unsafe, escapes its root, or traverses a symlink."""


class ArtifactNotFoundError(ArtifactError, FileNotFoundError):
    """A manifest row or immutable object is missing."""


class ArtifactIntegrityError(ArtifactError):
    """Stored metadata or bytes fail exact integrity verification."""


class ArtifactDivergenceError(ArtifactError):
    """One stable operation identity was retried with divergent input."""


class ArtifactCollisionError(ArtifactError):
    """An owner-generated identity ambiguously names different metadata."""


class StaleSelectionError(ArtifactError):
    """A compare-and-swap selection used a stale expected reference."""


def canonical_json(value: object) -> bytes:
    """Serialize protocol data in the canonical JSON representation."""
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def sha256_digest(content: bytes) -> str:
    """Return canonical lowercase SHA-256 over exact bytes."""
    if not isinstance(content, bytes):
        raise ArtifactValidationError("artifact content must be exact bytes")
    return hashlib.sha256(content).hexdigest()


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _timestamp(value: object, field: str) -> str:
    text = _text(value, field)
    if not text.endswith("Z"):
        raise ArtifactValidationError(f"{field} must be a canonical UTC timestamp ending in Z")
    try:
        parsed = datetime.fromisoformat(f"{text[:-1]}+00:00")
    except ValueError as exc:
        raise ArtifactValidationError(f"{field} must be a valid UTC timestamp") from exc
    if parsed.utcoffset() != timedelta(0):
        raise ArtifactValidationError(f"{field} must be UTC")
    return text


def _text(value: object, field: str) -> str:
    has_control = isinstance(value, str) and any(
        ord(character) < 32 or ord(character) == 127 for character in value
    )
    if not isinstance(value, str) or not value or value != value.strip() or has_control:
        raise ArtifactValidationError(f"{field} must be a non-empty canonical string")
    return value


def _nullable_text(value: object, field: str) -> str | None:
    if value is None:
        return None
    return _text(value, field)


def _positive_int(value: object, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ArtifactValidationError(f"{field} must be a positive integer")
    return value


def _nonnegative_int(value: object, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ArtifactValidationError(f"{field} must be a non-negative integer")
    return value


def _digest(value: object, field: str = "content_digest") -> str:
    text = _text(value, field)
    if not _DIGEST_RE.fullmatch(text):
        raise ArtifactValidationError(f"{field} must be canonical lowercase SHA-256")
    return text


def _kind(value: object) -> str:
    text = _text(value, "kind")
    if not _KIND_RE.fullmatch(text):
        raise ArtifactValidationError("kind must use lowercase kebab-case")
    return text


def _strict_required_fields(
    value: object,
    required: frozenset[str],
    allowed: frozenset[str],
    label: str,
) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ArtifactValidationError(f"{label} must be an object")
    keys = set(value.keys())
    if any(not isinstance(key, str) for key in keys):
        raise ArtifactValidationError(f"{label} field names must be strings")
    missing = sorted(required - keys)
    unknown = sorted(keys - allowed)
    if missing:
        raise ArtifactValidationError(f"{label} missing required fields: {', '.join(missing)}")
    if unknown:
        raise ArtifactValidationError(f"{label} has unknown fields: {', '.join(unknown)}")
    return value


def _strict_fields(value: object, expected: frozenset[str], label: str) -> Mapping[str, Any]:
    return _strict_required_fields(value, expected, expected, label)


def _canonical_scope(value: object, *, from_json: bool) -> tuple[str, ...]:
    expected_type = list if from_json else (list, tuple)
    if not isinstance(value, expected_type):
        raise ArtifactValidationError("consumer_scope must be an array of strings")
    scope = tuple(_text(item, "consumer_scope item") for item in value)
    if len(scope) != len(set(scope)):
        raise ArtifactValidationError("consumer_scope must not contain duplicates")
    if scope != tuple(sorted(scope)):
        raise ArtifactValidationError("consumer_scope must use canonical sorted order")
    return scope


def _canonical_upstreams(value: object, *, from_json: bool) -> tuple[ArtifactRef, ...]:
    expected_type = list if from_json else (list, tuple)
    if not isinstance(value, expected_type):
        raise ArtifactValidationError("upstream_refs must be an array")
    refs = tuple(
        ArtifactRef.from_dict(item) if from_json else _require_ref(item, "upstream ref")
        for item in value
    )
    ids = [ref.artifact_id for ref in refs]
    if len(ids) != len(set(ids)):
        raise ArtifactValidationError("upstream_refs must not contain duplicate artifacts")
    return refs


def _artifact_identity(
    *,
    run_id: str,
    phase: str,
    branch_id: str | None,
    kind: str,
    operation_id: str,
    version: int,
) -> dict[str, object]:
    return {
        "branch_id": branch_id,
        "kind": kind,
        "operation_id": operation_id,
        "phase": phase,
        "run_id": run_id,
        "version": version,
    }


def artifact_id_for(
    *,
    run_id: str,
    phase: str,
    branch_id: str | None,
    kind: str,
    operation_id: str,
    version: int,
) -> str:
    """Return the stable owner identity for one artifact operation/version."""
    run_id = _text(run_id, "run_id")
    phase = _text(phase, "phase")
    branch_id = _nullable_text(branch_id, "branch_id")
    kind = _kind(kind)
    operation_id = _text(operation_id, "operation_id")
    version = _positive_int(version, "version")
    identity = _artifact_identity(
        run_id=run_id,
        phase=phase,
        branch_id=branch_id,
        kind=kind,
        operation_id=operation_id,
        version=version,
    )
    return f"{_ARTIFACT_ID_PREFIX}{hashlib.sha256(canonical_json(identity)).hexdigest()}"


@dataclass(frozen=True)
class ArtifactRef:
    """Exact immutable reference carried across workflow protocol boundaries."""

    schema_version: int
    artifact_id: str
    run_id: str
    phase: str
    branch_id: str | None
    kind: str
    operation_id: str
    version: int
    producer: str
    consumer_scope: tuple[str, ...]
    media_type: str
    byte_length: int
    content_digest: str
    store_ref: str

    _FIELDS: ClassVar[frozenset[str]] = frozenset(
        {
            "schema_version",
            "artifact_id",
            "run_id",
            "phase",
            "branch_id",
            "kind",
            "operation_id",
            "version",
            "producer",
            "consumer_scope",
            "media_type",
            "byte_length",
            "content_digest",
            "store_ref",
        }
    )

    def __post_init__(self) -> None:
        if self.schema_version != ARTIFACT_SCHEMA_VERSION:
            raise ArtifactValidationError(
                f"unsupported ArtifactRef schema version: {self.schema_version}"
            )
        if not isinstance(self.artifact_id, str) or not _ARTIFACT_ID_RE.fullmatch(self.artifact_id):
            raise ArtifactValidationError("artifact_id must be a canonical owner identity")
        _text(self.run_id, "run_id")
        _text(self.phase, "phase")
        _nullable_text(self.branch_id, "branch_id")
        _kind(self.kind)
        _text(self.operation_id, "operation_id")
        _positive_int(self.version, "version")
        _text(self.producer, "producer")
        if not isinstance(self.consumer_scope, tuple):
            raise ArtifactValidationError("consumer_scope must be an immutable tuple")
        _canonical_scope(self.consumer_scope, from_json=False)
        _text(self.media_type, "media_type")
        _nonnegative_int(self.byte_length, "byte_length")
        _digest(self.content_digest)
        expected_id = artifact_id_for(
            run_id=self.run_id,
            phase=self.phase,
            branch_id=self.branch_id,
            kind=self.kind,
            operation_id=self.operation_id,
            version=self.version,
        )
        if self.artifact_id != expected_id:
            raise ArtifactValidationError("artifact_id does not match its canonical identity")
        expected_store_ref = f"{_OBJECT_URI_PREFIX}{self.content_digest}"
        if self.store_ref != expected_store_ref:
            raise ArtifactValidationError("store_ref does not match content_digest")

    @classmethod
    def from_dict(cls, value: object) -> ArtifactRef:
        """Parse one strict schema-v1 reference; unknown fields fail closed."""
        data = _strict_fields(value, cls._FIELDS, "ArtifactRef")
        return cls(
            schema_version=_positive_int(data["schema_version"], "schema_version"),
            artifact_id=_text(data["artifact_id"], "artifact_id"),
            run_id=_text(data["run_id"], "run_id"),
            phase=_text(data["phase"], "phase"),
            branch_id=_nullable_text(data["branch_id"], "branch_id"),
            kind=_kind(data["kind"]),
            operation_id=_text(data["operation_id"], "operation_id"),
            version=_positive_int(data["version"], "version"),
            producer=_text(data["producer"], "producer"),
            consumer_scope=_canonical_scope(data["consumer_scope"], from_json=True),
            media_type=_text(data["media_type"], "media_type"),
            byte_length=_nonnegative_int(data["byte_length"], "byte_length"),
            content_digest=_digest(data["content_digest"]),
            store_ref=_text(data["store_ref"], "store_ref"),
        )

    def to_dict(self) -> dict[str, object]:
        """Return the canonical JSON-compatible representation."""
        return {
            "schema_version": self.schema_version,
            "artifact_id": self.artifact_id,
            "run_id": self.run_id,
            "phase": self.phase,
            "branch_id": self.branch_id,
            "kind": self.kind,
            "operation_id": self.operation_id,
            "version": self.version,
            "producer": self.producer,
            "consumer_scope": list(self.consumer_scope),
            "media_type": self.media_type,
            "byte_length": self.byte_length,
            "content_digest": self.content_digest,
            "store_ref": self.store_ref,
        }


@dataclass(frozen=True)
class ArtifactEnvelope:
    """Manifest metadata for immutable content and its exact lineage."""

    schema_version: int
    artifact_id: str
    run_id: str
    phase: str
    branch_id: str | None
    kind: str
    operation_id: str
    version: int
    producer: str
    consumer_scope: tuple[str, ...]
    created_at: str
    media_type: str
    byte_length: int
    content_digest: str
    store_ref: str
    parent_ref: ArtifactRef | None
    upstream_refs: tuple[ArtifactRef, ...]

    _FIELDS: ClassVar[frozenset[str]] = ArtifactRef._FIELDS | frozenset(
        {"created_at", "parent_ref", "upstream_refs"}
    )

    def __post_init__(self) -> None:
        # Reuse all exact reference invariants before validating lineage.
        _ = self.ref
        _timestamp(self.created_at, "created_at")
        if self.parent_ref is not None and not isinstance(self.parent_ref, ArtifactRef):
            raise ArtifactValidationError("parent_ref must be an ArtifactRef or null")
        if not isinstance(self.upstream_refs, tuple):
            raise ArtifactValidationError("upstream_refs must be an immutable tuple")
        _canonical_upstreams(self.upstream_refs, from_json=False)
        if self.version == 1 and self.parent_ref is not None:
            raise ArtifactValidationError("version 1 artifacts cannot have a parent_ref")
        if self.version > 1 and self.parent_ref is None:
            raise ArtifactValidationError("revised artifacts require a parent_ref")
        if self.parent_ref is not None:
            parent = self.parent_ref
            if (
                parent.run_id != self.run_id
                or parent.phase != self.phase
                or parent.branch_id != self.branch_id
                or parent.kind != self.kind
                or parent.version != self.version - 1
            ):
                raise ArtifactValidationError(
                    "parent_ref must be the immediately preceding same-run artifact version"
                )
        if any(ref.run_id != self.run_id for ref in self.upstream_refs):
            raise ArtifactValidationError("upstream_refs must belong to the same run")

    @property
    def ref(self) -> ArtifactRef:
        """Return the exact transport reference for this envelope."""
        return ArtifactRef(
            schema_version=self.schema_version,
            artifact_id=self.artifact_id,
            run_id=self.run_id,
            phase=self.phase,
            branch_id=self.branch_id,
            kind=self.kind,
            operation_id=self.operation_id,
            version=self.version,
            producer=self.producer,
            consumer_scope=self.consumer_scope,
            media_type=self.media_type,
            byte_length=self.byte_length,
            content_digest=self.content_digest,
            store_ref=self.store_ref,
        )

    @classmethod
    def from_dict(cls, value: object) -> ArtifactEnvelope:
        """Parse one strict schema-v1 envelope; unknown fields fail closed."""
        data = _strict_fields(value, cls._FIELDS, "ArtifactEnvelope")
        parent_value = data["parent_ref"]
        parent = None if parent_value is None else ArtifactRef.from_dict(parent_value)
        return cls(
            schema_version=_positive_int(data["schema_version"], "schema_version"),
            artifact_id=_text(data["artifact_id"], "artifact_id"),
            run_id=_text(data["run_id"], "run_id"),
            phase=_text(data["phase"], "phase"),
            branch_id=_nullable_text(data["branch_id"], "branch_id"),
            kind=_kind(data["kind"]),
            operation_id=_text(data["operation_id"], "operation_id"),
            version=_positive_int(data["version"], "version"),
            producer=_text(data["producer"], "producer"),
            consumer_scope=_canonical_scope(data["consumer_scope"], from_json=True),
            created_at=_timestamp(data["created_at"], "created_at"),
            media_type=_text(data["media_type"], "media_type"),
            byte_length=_nonnegative_int(data["byte_length"], "byte_length"),
            content_digest=_digest(data["content_digest"]),
            store_ref=_text(data["store_ref"], "store_ref"),
            parent_ref=parent,
            upstream_refs=_canonical_upstreams(data["upstream_refs"], from_json=True),
        )

    def to_dict(self) -> dict[str, object]:
        """Return the canonical JSON-compatible representation."""
        value = self.ref.to_dict()
        value.update(
            {
                "created_at": self.created_at,
                "parent_ref": self.parent_ref.to_dict() if self.parent_ref else None,
                "upstream_refs": [ref.to_dict() for ref in self.upstream_refs],
            }
        )
        return value


@dataclass(frozen=True)
class OutputArtifactMetadata:
    """Strict execution-owner metadata carried on an agent directive."""

    schema_version: int
    run_id: str
    phase: str
    branch_id: str | None
    kind: str
    operation_id: str
    version: int
    producer: str
    consumer_scope: tuple[str, ...]
    media_type: str
    parent_ref: ArtifactRef | None
    upstream_refs: tuple[ArtifactRef, ...]

    _FIELDS: ClassVar[frozenset[str]] = frozenset(
        {
            "schema_version",
            "run_id",
            "phase",
            "branch_id",
            "kind",
            "operation_id",
            "version",
            "producer",
            "consumer_scope",
            "media_type",
            "parent_ref",
            "upstream_refs",
        }
    )

    def __post_init__(self) -> None:
        if self.schema_version != OUTPUT_ARTIFACT_SCHEMA_VERSION:
            raise ArtifactValidationError(
                f"unsupported output artifact metadata schema version: {self.schema_version}"
            )
        _text(self.run_id, "run_id")
        _text(self.phase, "phase")
        _nullable_text(self.branch_id, "branch_id")
        _kind(self.kind)
        _text(self.operation_id, "operation_id")
        _positive_int(self.version, "version")
        _text(self.producer, "producer")
        _canonical_scope(self.consumer_scope, from_json=False)
        _text(self.media_type, "media_type")
        if self.parent_ref is not None and not isinstance(self.parent_ref, ArtifactRef):
            raise ArtifactValidationError("parent_ref must be null or an ArtifactRef")
        _canonical_upstreams(self.upstream_refs, from_json=False)

        if self.version == 1 and self.parent_ref is not None:
            raise ArtifactValidationError("version 1 output metadata cannot have parent_ref")
        if self.version > 1 and self.parent_ref is None:
            raise ArtifactValidationError("revised output metadata requires parent_ref")
        if self.parent_ref is not None:
            parent = self.parent_ref
            if (
                parent.run_id != self.run_id
                or parent.phase != self.phase
                or parent.branch_id != self.branch_id
                or parent.kind != self.kind
                or parent.operation_id != self.operation_id
                or parent.version != self.version - 1
            ):
                raise ArtifactValidationError(
                    "parent_ref must be the immediately previous operation revision"
                )
        consumer = f"state:{self.phase}"
        for upstream in self.upstream_refs:
            if upstream.run_id != self.run_id:
                raise ArtifactValidationError("upstream_refs must belong to the directive run")
            if consumer not in upstream.consumer_scope:
                raise ArtifactValidationError("upstream_ref does not grant the producer state")

    @classmethod
    def from_dict(cls, value: object) -> OutputArtifactMetadata:
        """Parse one strict output-artifact owner contract."""
        data = _strict_fields(value, cls._FIELDS, "OutputArtifactMetadata")
        parent_value = data["parent_ref"]
        parent = None if parent_value is None else ArtifactRef.from_dict(parent_value)
        return cls(
            schema_version=_positive_int(data["schema_version"], "schema_version"),
            run_id=_text(data["run_id"], "run_id"),
            phase=_text(data["phase"], "phase"),
            branch_id=_nullable_text(data["branch_id"], "branch_id"),
            kind=_kind(data["kind"]),
            operation_id=_text(data["operation_id"], "operation_id"),
            version=_positive_int(data["version"], "version"),
            producer=_text(data["producer"], "producer"),
            consumer_scope=_canonical_scope(data["consumer_scope"], from_json=True),
            media_type=_text(data["media_type"], "media_type"),
            parent_ref=parent,
            upstream_refs=_canonical_upstreams(data["upstream_refs"], from_json=True),
        )

    def to_dict(self) -> dict[str, object]:
        """Return the exact JSON-compatible directive contract."""
        return {
            "schema_version": self.schema_version,
            "run_id": self.run_id,
            "phase": self.phase,
            "branch_id": self.branch_id,
            "kind": self.kind,
            "operation_id": self.operation_id,
            "version": self.version,
            "producer": self.producer,
            "consumer_scope": list(self.consumer_scope),
            "media_type": self.media_type,
            "parent_ref": self.parent_ref.to_dict() if self.parent_ref else None,
            "upstream_refs": [ref.to_dict() for ref in self.upstream_refs],
        }


@dataclass(frozen=True)
class ResultProtocolV2:
    """Exact skill-driver wrapper with owner fields outside model SUMMARY data."""

    protocol_version: int
    run_id: str
    phase: str
    branch_id: str | None
    producer: str
    operation_id: str
    output_artifact_ref: ArtifactRef
    execution_receipt: dict[str, Any]
    exit_code: int
    summary: dict[str, Any]
    summary_missing: bool
    receipts: tuple[dict[str, Any], ...]
    trusted_invocation: dict[str, Any]
    agent: str | None = None
    error: str | None = None

    _REQUIRED_FIELDS: ClassVar[frozenset[str]] = frozenset(
        {
            "protocol_version",
            "run_id",
            "phase",
            "branch_id",
            "producer",
            "operation_id",
            "output_artifact_ref",
            "execution_receipt",
            "exitCode",
            "summary",
            "summary_missing",
            "receipts",
            "trusted_invocation",
        }
    )
    _OPTIONAL_FIELDS: ClassVar[frozenset[str]] = frozenset({"error"})

    def __post_init__(self) -> None:  # noqa: C901 - exact wrapper validation
        if self.protocol_version != RESULT_PROTOCOL_VERSION:
            raise ArtifactValidationError(
                f"unsupported result protocol version: {self.protocol_version}"
            )
        _text(self.run_id, "run_id")
        _text(self.phase, "phase")
        _nullable_text(self.branch_id, "branch_id")
        _text(self.producer, "producer")
        _text(self.operation_id, "operation_id")
        if not isinstance(self.output_artifact_ref, ArtifactRef):
            raise ArtifactValidationError("output_artifact_ref must be an ArtifactRef")
        if not isinstance(self.execution_receipt, dict):
            raise ArtifactValidationError("execution_receipt must be an object")
        if type(self.exit_code) is not int or self.exit_code not in {0, 1}:
            raise ArtifactValidationError("exitCode must be integer 0 or 1")
        if not isinstance(self.summary, dict):
            raise ArtifactValidationError("summary must be an object")
        if type(self.summary_missing) is not bool:
            raise ArtifactValidationError("summary_missing must be a boolean")
        if not isinstance(self.receipts, tuple) or any(
            not isinstance(receipt, dict) for receipt in self.receipts
        ):
            raise ArtifactValidationError("receipts must be an array of objects")
        if not self.receipts or self.receipts[0] != self.execution_receipt:
            raise ArtifactValidationError("execution_receipt must be the first receipts entry")
        if not isinstance(self.trusted_invocation, dict):
            raise ArtifactValidationError("trusted_invocation must be an object")
        _nullable_text(self.agent, "agent")
        _nullable_text(self.error, "error")
        if self.error is not None and self.exit_code == 0 and not self.summary_missing:
            raise ArtifactValidationError(
                "error is only valid for failed or summary-missing results"
            )
        if self.summary_missing and self.summary:
            raise ArtifactValidationError("summary_missing results must carry an empty summary")
        ref = self.output_artifact_ref
        if (
            ref.run_id != self.run_id
            or ref.phase != self.phase
            or ref.branch_id != self.branch_id
            or ref.producer != self.producer
            or ref.operation_id != self.operation_id
        ):
            raise ArtifactValidationError(
                "output_artifact_ref does not match the trusted result identity"
            )
        if self.agent is not None and self.producer != f"agent:{self.agent}":
            raise ArtifactValidationError("parallel agent does not match result producer")

    @classmethod
    def _parse(cls, value: object, *, parallel: bool) -> ResultProtocolV2:
        required = cls._REQUIRED_FIELDS | ({"agent"} if parallel else set())
        allowed = frozenset(required) | cls._OPTIONAL_FIELDS
        data = _strict_required_fields(value, frozenset(required), allowed, "ResultProtocolV2")
        receipt = data["execution_receipt"]
        summary = data["summary"]
        receipts = data["receipts"]
        invocation = data["trusted_invocation"]
        if not isinstance(receipt, dict) or not isinstance(summary, dict):
            raise ArtifactValidationError("execution_receipt and summary must be objects")
        if not isinstance(receipts, list) or any(not isinstance(item, dict) for item in receipts):
            raise ArtifactValidationError("receipts must be an array of objects")
        if not isinstance(invocation, dict):
            raise ArtifactValidationError("trusted_invocation must be an object")
        exit_code = data["exitCode"]
        if type(exit_code) is not int:
            raise ArtifactValidationError("exitCode must be an integer")
        summary_missing = data["summary_missing"]
        if type(summary_missing) is not bool:
            raise ArtifactValidationError("summary_missing must be a boolean")
        error_value = data.get("error")
        return cls(
            protocol_version=_positive_int(data["protocol_version"], "protocol_version"),
            run_id=_text(data["run_id"], "run_id"),
            phase=_text(data["phase"], "phase"),
            branch_id=_nullable_text(data["branch_id"], "branch_id"),
            producer=_text(data["producer"], "producer"),
            operation_id=_text(data["operation_id"], "operation_id"),
            output_artifact_ref=ArtifactRef.from_dict(data["output_artifact_ref"]),
            execution_receipt=dict(receipt),
            exit_code=exit_code,
            summary=dict(summary),
            summary_missing=summary_missing,
            receipts=tuple(dict(item) for item in receipts),
            trusted_invocation=dict(invocation),
            agent=_text(data["agent"], "agent") if parallel else None,
            error=_text(error_value, "error") if error_value is not None else None,
        )

    @classmethod
    def from_dict(cls, value: object) -> ResultProtocolV2:
        """Parse the exact single-agent result-protocol-v2 wrapper."""
        return cls._parse(value, parallel=False)

    @classmethod
    def from_parallel_dict(cls, value: object) -> ResultProtocolV2:
        """Parse the exact parallel branch wrapper (with required ``agent``)."""
        return cls._parse(value, parallel=True)

    def to_dict(self) -> dict[str, object]:
        """Return the JSON-compatible driver wrapper."""
        value: dict[str, object] = {
            "protocol_version": self.protocol_version,
            "run_id": self.run_id,
            "phase": self.phase,
            "branch_id": self.branch_id,
            "producer": self.producer,
            "operation_id": self.operation_id,
            "output_artifact_ref": self.output_artifact_ref.to_dict(),
            "execution_receipt": dict(self.execution_receipt),
            "exitCode": self.exit_code,
            "summary": dict(self.summary),
            "summary_missing": self.summary_missing,
            "receipts": [dict(receipt) for receipt in self.receipts],
            "trusted_invocation": dict(self.trusted_invocation),
        }
        if self.agent is not None:
            value["agent"] = self.agent
        if self.error is not None:
            value["error"] = self.error
        return value


@dataclass(frozen=True)
class InputArtifactBinding:
    """One named artifact slot in an input-artifacts directive."""

    slot: str
    ref: ArtifactRef

    _FIELDS: ClassVar[frozenset[str]] = frozenset({"slot", "ref"})

    def __post_init__(self) -> None:
        _text(self.slot, "slot")
        if not isinstance(self.ref, ArtifactRef):
            raise ArtifactValidationError("input artifact ref must be an ArtifactRef")

    @classmethod
    def from_dict(cls, value: object) -> InputArtifactBinding:
        """Parse one strict input binding."""
        data = _strict_fields(value, cls._FIELDS, "InputArtifactBinding")
        return cls(slot=_text(data["slot"], "slot"), ref=ArtifactRef.from_dict(data["ref"]))

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-compatible input binding."""
        return {"slot": self.slot, "ref": self.ref.to_dict()}


@dataclass(frozen=True)
class InputArtifactsV1:
    """Versioned exact inputs granted to one downstream consumer."""

    schema_version: int
    run_id: str
    consumer: str
    artifacts: tuple[InputArtifactBinding, ...]

    _FIELDS: ClassVar[frozenset[str]] = frozenset(
        {"schema_version", "run_id", "consumer", "artifacts"}
    )

    def __post_init__(self) -> None:
        if self.schema_version != INPUT_ARTIFACTS_SCHEMA_VERSION:
            raise ArtifactValidationError(
                f"unsupported input_artifacts schema version: {self.schema_version}"
            )
        _text(self.run_id, "run_id")
        _text(self.consumer, "consumer")
        if not isinstance(self.artifacts, tuple):
            raise ArtifactValidationError("artifacts must be an immutable tuple")
        slots = [binding.slot for binding in self.artifacts]
        ids = [binding.ref.artifact_id for binding in self.artifacts]
        if len(slots) != len(set(slots)):
            raise ArtifactValidationError("input artifact slots must be unique")
        if len(ids) != len(set(ids)):
            raise ArtifactValidationError("input artifact refs must be unique")
        for binding in self.artifacts:
            if binding.ref.run_id != self.run_id:
                raise ArtifactValidationError(
                    "input artifact refs must belong to the directive run"
                )
            if self.consumer not in binding.ref.consumer_scope:
                raise ArtifactValidationError("input artifact ref does not grant the consumer")

    @classmethod
    def from_dict(cls, value: object) -> InputArtifactsV1:
        """Parse one strict directive input-artifacts wrapper."""
        data = _strict_fields(value, cls._FIELDS, "InputArtifactsV1")
        artifacts_value = data["artifacts"]
        if not isinstance(artifacts_value, list):
            raise ArtifactValidationError("artifacts must be an array")
        return cls(
            schema_version=_positive_int(data["schema_version"], "schema_version"),
            run_id=_text(data["run_id"], "run_id"),
            consumer=_text(data["consumer"], "consumer"),
            artifacts=tuple(InputArtifactBinding.from_dict(item) for item in artifacts_value),
        )

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-compatible input-artifacts wrapper."""
        return {
            "schema_version": self.schema_version,
            "run_id": self.run_id,
            "consumer": self.consumer,
            "artifacts": [binding.to_dict() for binding in self.artifacts],
        }


@dataclass(frozen=True)
class MaterializedArtifact:
    """Owner-only temporary exact bytes with an explicit expiry."""

    materialization_id: str
    artifact_ref: ArtifactRef
    path: Path
    range_start: int
    range_end: int
    expires_at: str


def _require_ref(value: object, field: str = "artifact ref") -> ArtifactRef:
    if not isinstance(value, ArtifactRef):
        raise ArtifactValidationError(f"{field} must be an ArtifactRef")
    return value


def resolve_artifact_root(
    root: str | Path | None = None,
    *,
    environ: Mapping[str, str] | None = None,
) -> Path:
    """Resolve caller configuration without consulting a project/operator path.

    Precedence is explicit argument, ``PENNY_ARTIFACT_ROOT``, then the XDG state
    location (``$XDG_STATE_HOME`` or ``$HOME/.local/state``).  Configured paths
    must be absolute; relative state roots fail rather than landing in a source or
    target working tree.
    """
    env = os.environ if environ is None else environ
    raw: str | Path
    if root is not None:
        raw = root
    elif ARTIFACT_ROOT_ENV in env:
        raw = env[ARTIFACT_ROOT_ENV]
        if not str(raw).strip():
            raise ArtifactValidationError(f"{ARTIFACT_ROOT_ENV} cannot be empty")
    else:
        if XDG_STATE_HOME_ENV in env:
            state_home = Path(env[XDG_STATE_HOME_ENV])
            if not str(state_home).strip():
                raise ArtifactValidationError(f"{XDG_STATE_HOME_ENV} cannot be empty")
        else:
            home_value = env.get("HOME")
            state_home = (Path(home_value) if home_value else Path.home()) / ".local" / "state"
        raw = state_home / "penny" / "artifacts"
    path = Path(raw)
    if not path.is_absolute():
        raise ArtifactValidationError("artifact root must be an absolute path")
    return path


def _source_root() -> Path | None:
    module = Path(__file__).resolve()
    for parent in module.parents:
        if (parent / ".git").exists():
            return parent
    return None


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _lstat(path: Path) -> os.stat_result | None:
    try:
        return path.lstat()
    except FileNotFoundError:
        return None


def _assert_owner(path: Path, info: os.stat_result) -> None:
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise ArtifactPathError(f"artifact path is not owned by the current user: {path}")


def _assert_directory(path: Path, *, harden: bool) -> None:
    info = _lstat(path)
    if info is None:
        raise ArtifactPathError(f"artifact directory is missing: {path}")
    if stat.S_ISLNK(info.st_mode):
        raise ArtifactPathError(f"artifact directory cannot be a symlink: {path}")
    if not stat.S_ISDIR(info.st_mode):
        raise ArtifactPathError(f"artifact directory is not a directory: {path}")
    _assert_owner(path, info)
    if harden:
        path.chmod(0o700)
    elif stat.S_IMODE(info.st_mode) & 0o077:
        raise ArtifactPathError(f"artifact directory is not owner-only: {path}")


def _fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        if exc.errno in {errno.EINVAL, errno.ENOTSUP, errno.EOPNOTSUPP}:
            return
        raise
    try:
        try:
            os.fsync(descriptor)
        except OSError as exc:
            if exc.errno not in {errno.EINVAL, errno.ENOTSUP, errno.EOPNOTSUPP, errno.EBADF}:
                raise
    finally:
        os.close(descriptor)


def _ensure_directory(path: Path) -> None:
    existed = _lstat(path) is not None
    if not existed:
        path.mkdir(mode=0o700, parents=True, exist_ok=False)
    _assert_directory(path, harden=True)
    if not existed:
        _fsync_directory(path.parent)


def _assert_safe_root_contents(path: Path) -> None:
    info = _lstat(path)
    if info is None:
        return
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise ArtifactPathError("artifact root must be a real directory")
    _assert_owner(path, info)
    managed_names = {
        "objects",
        "materialized",
        "manifest.sqlite3",
        "manifest.sqlite3-wal",
        "manifest.sqlite3-shm",
        "manifest.sqlite3-journal",
        # The v2 (TypeScript) engine shares this root and its CAS ``objects``
        # tree, differing only in its manifest database. Its manifest and
        # SQLite sidecars are managed files, not unrelated debris.
        "manifest-v2.db",
        "manifest-v2.db-wal",
        "manifest-v2.db-shm",
        "manifest-v2.db-journal",
    }
    unrelated = sorted(entry.name for entry in path.iterdir() if entry.name not in managed_names)
    if unrelated:
        raise ArtifactPathError("artifact root contains unrelated files and cannot be claimed")


def _assert_regular_owner_file(path: Path, *, mode: int | None = None) -> os.stat_result:
    info = _lstat(path)
    if info is None:
        raise ArtifactNotFoundError(f"artifact file is missing: {path}")
    if stat.S_ISLNK(info.st_mode):
        raise ArtifactPathError(f"artifact file cannot be a symlink: {path}")
    if not stat.S_ISREG(info.st_mode):
        raise ArtifactPathError(f"artifact file is not regular: {path}")
    _assert_owner(path, info)
    if mode is not None:
        path.chmod(mode)
    elif stat.S_IMODE(info.st_mode) & 0o077:
        raise ArtifactPathError(f"artifact file is not owner-only: {path}")
    return info


def _open_readonly(path: Path) -> int:
    _assert_regular_owner_file(path)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise ArtifactPathError(f"artifact file cannot be a symlink: {path}") from exc
        raise
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode):
        os.close(descriptor)
        raise ArtifactPathError(f"artifact file is not regular: {path}")
    _assert_owner(path, info)
    if stat.S_IMODE(info.st_mode) & 0o077:
        os.close(descriptor)
        raise ArtifactPathError(f"artifact file is not owner-only: {path}")
    return descriptor


class ArtifactStore:
    """Immutable CAS objects plus a dedicated transactional SQLite manifest."""

    def __init__(
        self,
        root: str | Path | None = None,
        *,
        environ: Mapping[str, str] | None = None,
    ) -> None:
        configured_root = resolve_artifact_root(root, environ=environ)
        configured_info = _lstat(configured_root)
        if configured_info is not None and stat.S_ISLNK(configured_info.st_mode):
            raise ArtifactPathError("artifact root cannot be a symlink")
        resolved_root = configured_root.resolve(strict=False)
        package_root = Path(__file__).resolve().parent
        source_root = _source_root()
        if _is_relative_to(resolved_root, package_root):
            raise ArtifactPathError("artifact root must be outside the package installation")
        if source_root is not None and _is_relative_to(resolved_root, source_root):
            raise ArtifactPathError("artifact root must be outside the source tree")
        _assert_safe_root_contents(resolved_root)

        self.root = resolved_root
        self.objects_root = self.root / "objects"
        self.sha256_root = self.objects_root / "sha256"
        self.materializations_root = self.root / "materialized"
        self.manifest_path = self.root / "manifest.sqlite3"

        _ensure_directory(self.root)
        _ensure_directory(self.objects_root)
        _ensure_directory(self.sha256_root)
        _ensure_directory(self.materializations_root)
        self._create_manifest_file()
        self._init_schema()

    def _create_manifest_file(self) -> None:
        info = _lstat(self.manifest_path)
        if info is not None:
            _assert_regular_owner_file(self.manifest_path, mode=0o600)
            return
        flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        try:
            descriptor = os.open(self.manifest_path, flags, 0o600)
        except FileExistsError:
            _assert_regular_owner_file(self.manifest_path, mode=0o600)
            return
        try:
            os.fchmod(descriptor, 0o600)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        _fsync_directory(self.root)

    def _assert_layout(self) -> None:
        for directory in (
            self.root,
            self.objects_root,
            self.sha256_root,
            self.materializations_root,
        ):
            _assert_directory(directory, harden=False)
        _assert_regular_owner_file(self.manifest_path)
        for suffix in ("-wal", "-shm"):
            candidate = Path(f"{self.manifest_path}{suffix}")
            if _lstat(candidate) is not None:
                _assert_regular_owner_file(candidate, mode=0o600)

    def _harden_manifest_files(self) -> None:
        _assert_regular_owner_file(self.manifest_path, mode=0o600)
        for suffix in ("-wal", "-shm"):
            candidate = Path(f"{self.manifest_path}{suffix}")
            if _lstat(candidate) is not None:
                _assert_regular_owner_file(candidate, mode=0o600)

    def _sync_manifest_files(self) -> None:
        self._harden_manifest_files()
        for candidate in (
            self.manifest_path,
            Path(f"{self.manifest_path}-wal"),
            Path(f"{self.manifest_path}-shm"),
        ):
            if _lstat(candidate) is None:
                continue
            descriptor = _open_readonly(candidate)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        _fsync_directory(self.root)

    def _connect(self) -> sqlite3.Connection:
        self._assert_layout()
        connection = sqlite3.connect(str(self.manifest_path), timeout=30.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA journal_mode=WAL")
        self._harden_manifest_files()
        return connection

    def _init_schema(self) -> None:
        connection = self._connect()
        try:
            connection.executescript(_MANIFEST_SCHEMA)
            connection.commit()
            self._sync_manifest_files()
        finally:
            connection.close()

    def _object_path(self, digest: str, *, create_shard: bool) -> Path:
        digest = _digest(digest)
        shard = self.sha256_root / digest[:2]
        if create_shard:
            _ensure_directory(shard)
        else:
            _assert_directory(shard, harden=False)
        path = shard / digest[2:]
        if path.parent != shard or not _is_relative_to(path, self.sha256_root):
            raise ArtifactPathError("artifact object path escaped the CAS root")
        return path

    def _verify_object(self, digest: str, expected_length: int) -> Path:
        path = self._object_path(digest, create_shard=False)
        descriptor = _open_readonly(path)
        hasher = hashlib.sha256()
        length = 0
        try:
            with os.fdopen(descriptor, "rb", closefd=True) as stream:
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    hasher.update(chunk)
                    length += len(chunk)
        except Exception:
            # fdopen owns the descriptor after successful construction.
            raise
        if length != expected_length:
            raise ArtifactIntegrityError(
                f"artifact object length mismatch for {digest}: {length} != {expected_length}"
            )
        actual = hasher.hexdigest()
        if actual != digest:
            raise ArtifactIntegrityError(
                f"artifact object digest mismatch for {digest}: found {actual}"
            )
        return path

    def _atomic_write_object(self, content: bytes, digest: str) -> Path:
        path = self._object_path(digest, create_shard=True)
        existing = _lstat(path)
        if existing is not None:
            if stat.S_ISLNK(existing.st_mode):
                raise ArtifactPathError(f"artifact object cannot be a symlink: {path}")
            self._verify_object(digest, len(content))
            return path

        descriptor, temporary_name = tempfile.mkstemp(prefix=".artifact-", dir=path.parent)
        temporary = Path(temporary_name)
        try:
            os.fchmod(descriptor, 0o600)
            view = memoryview(content)
            written = 0
            while written < len(content):
                written += os.write(descriptor, view[written:])
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

        try:
            existing = _lstat(path)
            if existing is not None:
                if stat.S_ISLNK(existing.st_mode):
                    raise ArtifactPathError(f"artifact object cannot be a symlink: {path}")
                self._verify_object(digest, len(content))
                return path
            os.replace(temporary, path)
            _assert_regular_owner_file(path, mode=0o600)
            self._verify_object(digest, len(content))
            _fsync_directory(path.parent)
            return path
        finally:
            if _lstat(temporary) is not None:
                temporary.unlink()

    def _atomic_write_materialization(self, destination: Path, content: bytes) -> None:
        if destination.parent != self.materializations_root:
            raise ArtifactPathError("materialization path escaped its root")
        if _lstat(destination) is not None:
            raise ArtifactCollisionError("materialization identity collision")
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".materialization-", dir=self.materializations_root
        )
        temporary = Path(temporary_name)
        try:
            os.fchmod(descriptor, 0o600)
            view = memoryview(content)
            written = 0
            while written < len(content):
                written += os.write(descriptor, view[written:])
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        try:
            if _lstat(destination) is not None:
                raise ArtifactCollisionError("materialization identity collision")
            os.replace(temporary, destination)
            _assert_regular_owner_file(destination, mode=0o600)
            _fsync_directory(self.materializations_root)
        finally:
            if _lstat(temporary) is not None:
                temporary.unlink()

    @staticmethod
    def _branch_key(branch_id: str | None) -> str:
        return _BRANCH_NONE if branch_id is None else branch_id

    def _row_to_envelope(self, row: sqlite3.Row) -> ArtifactEnvelope:
        try:
            raw = json.loads(row["envelope_json"])
            envelope = ArtifactEnvelope.from_dict(raw)
        except (json.JSONDecodeError, KeyError, TypeError, ArtifactValidationError) as exc:
            raise ArtifactIntegrityError("artifact manifest envelope is invalid") from exc
        canonical = canonical_json(envelope.to_dict()).decode("utf-8")
        if row["envelope_json"] != canonical:
            raise ArtifactIntegrityError("artifact manifest envelope is not canonical JSON")
        expected_columns: dict[str, object] = {
            "artifact_id": envelope.artifact_id,
            "schema_version": envelope.schema_version,
            "run_id": envelope.run_id,
            "phase": envelope.phase,
            "branch_key": self._branch_key(envelope.branch_id),
            "kind": envelope.kind,
            "operation_id": envelope.operation_id,
            "version": envelope.version,
            "producer": envelope.producer,
            "media_type": envelope.media_type,
            "byte_length": envelope.byte_length,
            "content_digest": envelope.content_digest,
            "store_ref": envelope.store_ref,
            "created_at": envelope.created_at,
        }
        for column, expected in expected_columns.items():
            if row[column] != expected:
                raise ArtifactIntegrityError(f"artifact manifest column mismatch: {column}")
        return envelope

    def _load_envelope(
        self, connection: sqlite3.Connection, artifact_id: str
    ) -> ArtifactEnvelope | None:
        row = connection.execute(
            "SELECT * FROM artifacts WHERE artifact_id = ?", (artifact_id,)
        ).fetchone()
        return self._row_to_envelope(row) if row is not None else None

    def _load_operation(
        self,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        phase: str,
        branch_id: str | None,
        kind: str,
        operation_id: str,
        version: int,
    ) -> ArtifactEnvelope | None:
        row = connection.execute(
            """
            SELECT * FROM artifacts
            WHERE run_id = ? AND phase = ? AND branch_key = ? AND kind = ?
              AND operation_id = ? AND version = ?
            """,
            (
                run_id,
                phase,
                self._branch_key(branch_id),
                kind,
                operation_id,
                version,
            ),
        ).fetchone()
        return self._row_to_envelope(row) if row is not None else None

    @staticmethod
    def _retry_signature(envelope: ArtifactEnvelope) -> dict[str, object]:
        value = envelope.to_dict()
        value.pop("created_at")
        return value

    def _assert_retry_matches(
        self, existing: ArtifactEnvelope, requested: ArtifactEnvelope
    ) -> ArtifactRef:
        if self._retry_signature(existing) != self._retry_signature(requested):
            raise ArtifactDivergenceError(
                "stable operation identity was retried with divergent content or metadata"
            )
        self._validate_stored_ref(existing.ref, visited={})
        return existing.ref

    def _validate_lineage_for_put(
        self,
        *,
        run_id: str,
        phase: str,
        branch_id: str | None,
        kind: str,
        version: int,
        parent_ref: ArtifactRef | None,
        upstream_refs: tuple[ArtifactRef, ...],
    ) -> None:
        if version == 1 and parent_ref is not None:
            raise ArtifactValidationError("version 1 artifacts cannot have a parent_ref")
        if version > 1 and parent_ref is None:
            raise ArtifactValidationError("revised artifacts require a parent_ref")
        if parent_ref is not None:
            if (
                parent_ref.run_id != run_id
                or parent_ref.phase != phase
                or parent_ref.branch_id != branch_id
                or parent_ref.kind != kind
                or parent_ref.version != version - 1
            ):
                raise ArtifactValidationError(
                    "parent_ref must be the immediately preceding same-run artifact version"
                )
            self.validate(
                parent_ref,
                expected_run_id=run_id,
                expected_phase=phase,
                expected_branch_id=branch_id,
            )
        for upstream in upstream_refs:
            if upstream.run_id != run_id:
                raise ArtifactValidationError("upstream_refs must belong to the same run")
            self.validate(upstream, expected_run_id=run_id)

    @staticmethod
    def _owner_scope(consumer_scope: Sequence[str]) -> tuple[str, ...]:
        if isinstance(consumer_scope, (str, bytes)):
            raise ArtifactValidationError("consumer_scope must be a sequence of strings")
        scope_items = tuple(_text(item, "consumer_scope item") for item in consumer_scope)
        if len(scope_items) != len(set(scope_items)):
            raise ArtifactValidationError("consumer_scope must not contain duplicates")
        return tuple(sorted(scope_items))

    def _find_existing_operation(self, requested: ArtifactEnvelope) -> ArtifactEnvelope | None:
        connection = self._connect()
        try:
            return self._load_operation(
                connection,
                run_id=requested.run_id,
                phase=requested.phase,
                branch_id=requested.branch_id,
                kind=requested.kind,
                operation_id=requested.operation_id,
                version=requested.version,
            )
        finally:
            connection.close()

    def _insert_artifact_row(
        self, connection: sqlite3.Connection, requested: ArtifactEnvelope
    ) -> None:
        connection.execute(
            """
            INSERT INTO artifacts (
              artifact_id, schema_version, run_id, phase, branch_key, kind,
              operation_id, version, producer, media_type, byte_length,
              content_digest, store_ref, created_at, envelope_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                requested.artifact_id,
                requested.schema_version,
                requested.run_id,
                requested.phase,
                self._branch_key(requested.branch_id),
                requested.kind,
                requested.operation_id,
                requested.version,
                requested.producer,
                requested.media_type,
                requested.byte_length,
                requested.content_digest,
                requested.store_ref,
                requested.created_at,
                canonical_json(requested.to_dict()).decode("utf-8"),
            ),
        )

    def _commit_artifact(self, requested: ArtifactEnvelope) -> tuple[ArtifactRef, bool]:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            existing = self._load_operation(
                connection,
                run_id=requested.run_id,
                phase=requested.phase,
                branch_id=requested.branch_id,
                kind=requested.kind,
                operation_id=requested.operation_id,
                version=requested.version,
            )
            if existing is not None:
                connection.rollback()
                return self._assert_retry_matches(existing, requested), False
            if self._load_envelope(connection, requested.artifact_id) is not None:
                raise ArtifactCollisionError("artifact identity collision")
            self._insert_artifact_row(connection, requested)
            connection.commit()
            self._sync_manifest_files()
            return requested.ref, True
        except Exception:
            if connection.in_transaction:
                connection.rollback()
            raise
        finally:
            connection.close()

    def put(
        self,
        content: bytes,
        *,
        run_id: str,
        phase: str,
        kind: str,
        operation_id: str,
        version: int,
        producer: str,
        consumer_scope: Sequence[str],
        media_type: str,
        branch_id: str | None = None,
        parent_ref: ArtifactRef | None = None,
        upstream_refs: Sequence[ArtifactRef] = (),
    ) -> ArtifactRef:
        """Persist exact bytes and immutable metadata for one stable operation.

        An identical retry returns the original reference.  Any content, metadata,
        or lineage divergence for the same operation identity fails loud.  Object
        persistence precedes the manifest transaction, so a crash can leave only a
        harmless orphaned CAS object and can never acknowledge a missing object.
        """
        if not isinstance(content, bytes):
            raise ArtifactValidationError("artifact content must be exact bytes")
        run_id = _text(run_id, "run_id")
        phase = _text(phase, "phase")
        branch_id = _nullable_text(branch_id, "branch_id")
        kind = _kind(kind)
        operation_id = _text(operation_id, "operation_id")
        version = _positive_int(version, "version")
        producer = _text(producer, "producer")
        scope = self._owner_scope(consumer_scope)
        media_type = _text(media_type, "media_type")
        parent = None if parent_ref is None else _require_ref(parent_ref, "parent_ref")
        upstream = _canonical_upstreams(tuple(upstream_refs), from_json=False)
        digest = sha256_digest(content)
        requested = ArtifactEnvelope(
            schema_version=ARTIFACT_SCHEMA_VERSION,
            artifact_id=artifact_id_for(
                run_id=run_id,
                phase=phase,
                branch_id=branch_id,
                kind=kind,
                operation_id=operation_id,
                version=version,
            ),
            run_id=run_id,
            phase=phase,
            branch_id=branch_id,
            kind=kind,
            operation_id=operation_id,
            version=version,
            producer=producer,
            consumer_scope=scope,
            created_at=_now_utc(),
            media_type=media_type,
            byte_length=len(content),
            content_digest=digest,
            store_ref=f"{_OBJECT_URI_PREFIX}{digest}",
            parent_ref=parent,
            upstream_refs=upstream,
        )
        existing = self._find_existing_operation(requested)
        if existing is not None:
            return self._assert_retry_matches(existing, requested)
        self._validate_lineage_for_put(
            run_id=run_id,
            phase=phase,
            branch_id=branch_id,
            kind=kind,
            version=version,
            parent_ref=parent,
            upstream_refs=upstream,
        )
        self._atomic_write_object(content, digest)
        ref, inserted = self._commit_artifact(requested)
        if inserted:
            self._log_event("stored", requested)
        return ref

    def _validate_stored_ref(
        self,
        ref: ArtifactRef,
        *,
        visited: dict[str, tuple[ArtifactRef, ArtifactEnvelope]],
    ) -> ArtifactEnvelope:
        prior = visited.get(ref.artifact_id)
        if prior is not None:
            if prior[0] != ref:
                raise ArtifactIntegrityError("lineage contains conflicting refs for one artifact")
            return prior[1]
        connection = self._connect()
        try:
            envelope = self._load_envelope(connection, ref.artifact_id)
        finally:
            connection.close()
        if envelope is None:
            raise ArtifactNotFoundError(f"artifact manifest row not found: {ref.artifact_id}")
        if envelope.ref != ref:
            raise ArtifactIntegrityError("artifact ref does not exactly match manifest metadata")
        visited[ref.artifact_id] = (ref, envelope)
        self._verify_object(envelope.content_digest, envelope.byte_length)
        if envelope.parent_ref is not None:
            self._validate_stored_ref(envelope.parent_ref, visited=visited)
        for upstream in envelope.upstream_refs:
            self._validate_stored_ref(upstream, visited=visited)
        return envelope

    def _selected_ref_raw(
        self,
        *,
        run_id: str,
        phase: str,
        branch_id: str | None,
        kind: str,
    ) -> ArtifactRef | None:
        connection = self._connect()
        try:
            row = connection.execute(
                """
                SELECT a.*, s.version AS selected_version
                FROM artifact_selections AS s
                JOIN artifacts AS a ON a.artifact_id = s.artifact_id
                WHERE s.run_id = ? AND s.phase = ? AND s.branch_key = ? AND s.kind = ?
                """,
                (run_id, phase, self._branch_key(branch_id), kind),
            ).fetchone()
            if row is None:
                return None
            envelope = self._row_to_envelope(row)
            if row["selected_version"] != envelope.version:
                raise ArtifactIntegrityError("artifact selection version does not match its ref")
            return envelope.ref
        finally:
            connection.close()

    def validate(
        self,
        ref: ArtifactRef | Mapping[str, Any],
        *,
        expected_run_id: str,
        expected_phase: str | None = None,
        expected_branch_id: str | None | object = _NO_EXPECTED_BRANCH,
        expected_producer: str | None = None,
        consumer: str | None = None,
        require_selected: bool = False,
    ) -> ArtifactEnvelope:
        """Verify exact manifest metadata, object bytes, lineage, and caller scope."""
        parsed = ref if isinstance(ref, ArtifactRef) else ArtifactRef.from_dict(ref)
        expected_run_id = _text(expected_run_id, "expected_run_id")
        if parsed.run_id != expected_run_id:
            raise ArtifactValidationError("artifact belongs to the wrong run")
        if expected_phase is not None and parsed.phase != _text(expected_phase, "expected_phase"):
            raise ArtifactValidationError("artifact belongs to the wrong phase")
        if expected_branch_id is not _NO_EXPECTED_BRANCH:
            branch = _nullable_text(expected_branch_id, "expected_branch_id")
            if parsed.branch_id != branch:
                raise ArtifactValidationError("artifact belongs to the wrong branch")
        if expected_producer is not None and parsed.producer != _text(
            expected_producer, "expected_producer"
        ):
            raise ArtifactValidationError("artifact belongs to the wrong producer")
        if consumer is not None and _text(consumer, "consumer") not in parsed.consumer_scope:
            raise ArtifactValidationError("artifact does not grant the requested consumer")
        envelope = self._validate_stored_ref(parsed, visited={})
        if require_selected:
            selected = self._selected_ref_raw(
                run_id=parsed.run_id,
                phase=parsed.phase,
                branch_id=parsed.branch_id,
                kind=parsed.kind,
            )
            if selected != parsed:
                raise StaleSelectionError("artifact ref is not the current selected version")
        return envelope

    @staticmethod
    def _selection_key(ref: ArtifactRef) -> tuple[str, str, str | None, str]:
        return (ref.run_id, ref.phase, ref.branch_id, ref.kind)

    def _prepare_selection(
        self,
        ref: ArtifactRef | Mapping[str, Any],
        expected: ArtifactRef | Mapping[str, Any] | None,
    ) -> tuple[ArtifactRef, ArtifactRef | None]:
        desired = ref if isinstance(ref, ArtifactRef) else ArtifactRef.from_dict(ref)
        prior = (
            None
            if expected is None
            else expected if isinstance(expected, ArtifactRef) else ArtifactRef.from_dict(expected)
        )
        self.validate(desired, expected_run_id=desired.run_id)
        if prior is not None:
            self.validate(prior, expected_run_id=desired.run_id)
            if self._selection_key(prior) != self._selection_key(desired):
                raise ArtifactValidationError("expected ref belongs to another selection key")
        return desired, prior

    def _current_selection(
        self, connection: sqlite3.Connection, desired: ArtifactRef
    ) -> ArtifactRef | None:
        row = connection.execute(
            """
            SELECT a.* FROM artifact_selections AS s
            JOIN artifacts AS a ON a.artifact_id = s.artifact_id
            WHERE s.run_id = ? AND s.phase = ? AND s.branch_key = ? AND s.kind = ?
            """,
            (
                desired.run_id,
                desired.phase,
                self._branch_key(desired.branch_id),
                desired.kind,
            ),
        ).fetchone()
        return self._row_to_envelope(row).ref if row is not None else None

    def _write_selection(
        self,
        connection: sqlite3.Connection,
        *,
        desired: ArtifactRef,
        desired_envelope: ArtifactEnvelope,
        current: ArtifactRef | None,
    ) -> None:
        selected_at = _now_utc()
        if current is None:
            if desired.version != 1 or desired_envelope.parent_ref is not None:
                raise StaleSelectionError("initial selection must be an unparented version 1")
            connection.execute(
                """
                INSERT INTO artifact_selections
                  (run_id, phase, branch_key, kind, artifact_id, version, selected_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    desired.run_id,
                    desired.phase,
                    self._branch_key(desired.branch_id),
                    desired.kind,
                    desired.artifact_id,
                    desired.version,
                    selected_at,
                ),
            )
            return
        if desired.version != current.version + 1 or desired_envelope.parent_ref != current:
            raise StaleSelectionError("selected revisions must directly parent the current version")
        updated = connection.execute(
            """
            UPDATE artifact_selections
            SET artifact_id = ?, version = ?, selected_at = ?
            WHERE run_id = ? AND phase = ? AND branch_key = ? AND kind = ?
              AND artifact_id = ? AND version = ?
            """,
            (
                desired.artifact_id,
                desired.version,
                selected_at,
                desired.run_id,
                desired.phase,
                self._branch_key(desired.branch_id),
                desired.kind,
                current.artifact_id,
                current.version,
            ),
        )
        if updated.rowcount != 1:
            raise StaleSelectionError("artifact selection changed concurrently")

    def select(
        self,
        ref: ArtifactRef | Mapping[str, Any],
        *,
        expected: ArtifactRef | Mapping[str, Any] | None,
    ) -> ArtifactRef:
        """Select a current version with compare-and-swap and idempotent retry."""
        desired, prior = self._prepare_selection(ref, expected)
        connection = self._connect()
        desired_envelope: ArtifactEnvelope | None = None
        try:
            connection.execute("BEGIN IMMEDIATE")
            current = self._current_selection(connection, desired)
            if current == desired:
                connection.rollback()
                return desired
            if current != prior:
                raise StaleSelectionError("artifact selection compare-and-swap is stale")
            desired_envelope = self._load_envelope(connection, desired.artifact_id)
            if desired_envelope is None:
                raise ArtifactNotFoundError("desired artifact is missing from the manifest")
            self._write_selection(
                connection,
                desired=desired,
                desired_envelope=desired_envelope,
                current=current,
            )
            connection.commit()
            self._sync_manifest_files()
        except sqlite3.IntegrityError as exc:
            if connection.in_transaction:
                connection.rollback()
            raise StaleSelectionError("artifact selection changed concurrently") from exc
        except Exception:
            if connection.in_transaction:
                connection.rollback()
            raise
        finally:
            connection.close()
        if desired_envelope is None:
            raise ArtifactIntegrityError("selected artifact envelope was not loaded")
        self._log_event("selected", desired_envelope)
        return desired

    def get_selected(
        self,
        *,
        run_id: str,
        phase: str,
        kind: str,
        branch_id: str | None = None,
    ) -> ArtifactRef | None:
        """Return and integrity-check the exact current selected reference."""
        run_id = _text(run_id, "run_id")
        phase = _text(phase, "phase")
        kind = _kind(kind)
        branch_id = _nullable_text(branch_id, "branch_id")
        selected = self._selected_ref_raw(
            run_id=run_id,
            phase=phase,
            branch_id=branch_id,
            kind=kind,
        )
        if selected is None:
            return None
        self.validate(
            selected,
            expected_run_id=run_id,
            expected_phase=phase,
            expected_branch_id=branch_id,
            require_selected=True,
        )
        return selected

    @staticmethod
    def _byte_range(start: object, end: object, length: int) -> tuple[int, int]:
        range_start = _nonnegative_int(start, "start")
        range_end = length if end is None else _nonnegative_int(end, "end")
        if range_start > range_end or range_end > length:
            raise ArtifactValidationError("artifact byte range is outside the exact object")
        return range_start, range_end

    def read_range(
        self,
        ref: ArtifactRef | Mapping[str, Any],
        *,
        expected_run_id: str,
        start: int = 0,
        end: int | None = None,
        expected_phase: str | None = None,
        expected_branch_id: str | None | object = _NO_EXPECTED_BRANCH,
        expected_producer: str | None = None,
        consumer: str | None = None,
        require_selected: bool = False,
    ) -> bytes:
        """Return the exact half-open byte range ``[start, end)`` after validation."""
        parsed = ref if isinstance(ref, ArtifactRef) else ArtifactRef.from_dict(ref)
        envelope = self.validate(
            parsed,
            expected_run_id=expected_run_id,
            expected_phase=expected_phase,
            expected_branch_id=expected_branch_id,
            expected_producer=expected_producer,
            consumer=consumer,
            require_selected=require_selected,
        )
        range_start, range_end = self._byte_range(start, end, envelope.byte_length)
        path = self._object_path(envelope.content_digest, create_shard=False)
        descriptor = _open_readonly(path)
        try:
            os.lseek(descriptor, range_start, os.SEEK_SET)
            remaining = range_end - range_start
            chunks: list[bytes] = []
            while remaining:
                chunk = os.read(descriptor, remaining)
                if not chunk:
                    raise ArtifactIntegrityError("artifact object ended during exact range read")
                chunks.append(chunk)
                remaining -= len(chunk)
            content = b"".join(chunks)
        finally:
            os.close(descriptor)
        self._log_event(
            "read",
            envelope,
            range_start=range_start,
            range_end=range_end,
        )
        return content

    def read_bytes(
        self,
        ref: ArtifactRef | Mapping[str, Any],
        *,
        expected_run_id: str,
        expected_phase: str | None = None,
        expected_branch_id: str | None | object = _NO_EXPECTED_BRANCH,
        expected_producer: str | None = None,
        consumer: str | None = None,
        require_selected: bool = False,
    ) -> bytes:
        """Return all exact bytes after the same strict validation as ranged reads."""
        return self.read_range(
            ref,
            expected_run_id=expected_run_id,
            expected_phase=expected_phase,
            expected_branch_id=expected_branch_id,
            expected_producer=expected_producer,
            consumer=consumer,
            require_selected=require_selected,
        )

    def materialize(
        self,
        ref: ArtifactRef | Mapping[str, Any],
        *,
        expected_run_id: str,
        start: int = 0,
        end: int | None = None,
        ttl_seconds: int = DEFAULT_MATERIALIZATION_TTL_SECONDS,
        expected_phase: str | None = None,
        expected_branch_id: str | None | object = _NO_EXPECTED_BRANCH,
        expected_producer: str | None = None,
        consumer: str | None = None,
        require_selected: bool = False,
    ) -> MaterializedArtifact:
        """Create an owner-only exact range file under the artifact root."""
        ttl_seconds = _positive_int(ttl_seconds, "ttl_seconds")
        parsed = ref if isinstance(ref, ArtifactRef) else ArtifactRef.from_dict(ref)
        envelope = self.validate(
            parsed,
            expected_run_id=expected_run_id,
            expected_phase=expected_phase,
            expected_branch_id=expected_branch_id,
            expected_producer=expected_producer,
            consumer=consumer,
            require_selected=require_selected,
        )
        range_start, range_end = self._byte_range(start, end, envelope.byte_length)
        content = self.read_range(
            parsed,
            expected_run_id=expected_run_id,
            start=range_start,
            end=range_end,
            expected_phase=expected_phase,
            expected_branch_id=expected_branch_id,
            expected_producer=expected_producer,
            consumer=consumer,
            require_selected=require_selected,
        )
        materialization_id = f"mat_{secrets.token_hex(16)}"
        destination = self.materializations_root / materialization_id
        expires_at = (
            (datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds))
            .isoformat(timespec="microseconds")
            .replace("+00:00", "Z")
        )
        self._atomic_write_materialization(destination, content)

        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                INSERT INTO artifact_materializations
                  (materialization_id, artifact_id, path_name, range_start, range_end, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    materialization_id,
                    parsed.artifact_id,
                    materialization_id,
                    range_start,
                    range_end,
                    expires_at,
                ),
            )
            connection.commit()
            self._sync_manifest_files()
        except Exception:
            if connection.in_transaction:
                connection.rollback()
            if _lstat(destination) is not None:
                destination.unlink()
                _fsync_directory(self.materializations_root)
            raise
        finally:
            connection.close()
        self._log_event(
            "materialized",
            envelope,
            range_start=range_start,
            range_end=range_end,
            expires_at=expires_at,
        )
        return MaterializedArtifact(
            materialization_id=materialization_id,
            artifact_ref=parsed,
            path=destination,
            range_start=range_start,
            range_end=range_end,
            expires_at=expires_at,
        )

    def _materialization_path(self, materialization_id: str, path_name: str) -> Path:
        if not _MATERIALIZATION_ID_RE.fullmatch(materialization_id):
            raise ArtifactPathError("invalid materialization identity")
        if path_name != materialization_id or not _MATERIALIZATION_ID_RE.fullmatch(path_name):
            raise ArtifactPathError("materialization manifest path is unsafe")
        path = self.materializations_root / path_name
        if path.parent != self.materializations_root:
            raise ArtifactPathError("materialization path escaped its root")
        return path

    def release_materialization(self, materialization_id: str) -> bool:
        """Delete one explicit temporary materialization and its manifest record."""
        materialization_id = _text(materialization_id, "materialization_id")
        if not _MATERIALIZATION_ID_RE.fullmatch(materialization_id):
            raise ArtifactValidationError("invalid materialization identity")
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT path_name FROM artifact_materializations
                WHERE materialization_id = ?
                """,
                (materialization_id,),
            ).fetchone()
            if row is None:
                connection.rollback()
                return False
            path = self._materialization_path(materialization_id, row["path_name"])
            info = _lstat(path)
            if info is not None:
                if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                    connection.rollback()
                    raise ArtifactPathError("materialization file is unsafe")
                path.unlink()
                _fsync_directory(self.materializations_root)
            connection.execute(
                "DELETE FROM artifact_materializations WHERE materialization_id = ?",
                (materialization_id,),
            )
            connection.commit()
            self._sync_manifest_files()
            return True
        except Exception:
            if connection.in_transaction:
                connection.rollback()
            raise
        finally:
            connection.close()

    def cleanup_expired(self, *, now: datetime | None = None) -> int:
        """Delete expired owner-only materializations; immutable objects remain."""
        instant = datetime.now(timezone.utc) if now is None else now
        if instant.tzinfo is None or instant.utcoffset() != timedelta(0):
            raise ArtifactValidationError("cleanup time must be timezone-aware UTC")
        cutoff = instant.isoformat(timespec="microseconds").replace("+00:00", "Z")
        connection = self._connect()
        removed = 0
        try:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute(
                """
                SELECT materialization_id, path_name
                FROM artifact_materializations
                WHERE expires_at <= ?
                ORDER BY materialization_id
                """,
                (cutoff,),
            ).fetchall()
            for row in rows:
                path = self._materialization_path(row["materialization_id"], row["path_name"])
                info = _lstat(path)
                if info is not None:
                    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                        connection.rollback()
                        raise ArtifactPathError("materialization file is unsafe")
                    path.unlink()
                    removed += 1
            connection.execute(
                "DELETE FROM artifact_materializations WHERE expires_at <= ?", (cutoff,)
            )
            connection.commit()
            if rows:
                _fsync_directory(self.materializations_root)
                self._sync_manifest_files()
            return removed
        except Exception:
            if connection.in_transaction:
                connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def _log_event(
        event: str,
        envelope: ArtifactEnvelope,
        **metadata: object,
    ) -> None:
        fields: dict[str, object] = {
            "artifact_event": event,
            "artifact_id": envelope.artifact_id,
            "run_id": envelope.run_id,
            "phase": envelope.phase,
            "branch_id": envelope.branch_id,
            "kind": envelope.kind,
            "operation_id": envelope.operation_id,
            "version": envelope.version,
            "content_digest": envelope.content_digest,
            "byte_length": envelope.byte_length,
        }
        fields.update(metadata)
        _LOG.info("artifact_store_event", extra=fields)
