"""Durable accepted-write journal and exact HTTP-hub write adapter.

A write is never acknowledged to its caller until an intent, remote result, and
post-ack exact read have each been appended and fsynced.  Ambiguous outcomes
remain pending and are never retried by the normal write path.
"""

from __future__ import annotations

import fcntl
import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, cast

from .admin_client import AdminClientError, MemoryAdminClient
from .common import (
    JSON_READ_LIMIT_BYTES,
    ValidationError,
    canonical_json_bytes,
    require_identifier,
    require_sha256,
    require_utc_timestamp,
    sha256_bytes,
    utc_now,
)
from .cutover_config import OperationSpec

JOURNAL_SCHEMA_VERSION = 1
JOURNAL_TYPE = "memory-accepted-write"
EVENT_PREPARED = "prepared"
EVENT_REMOTE_ACK = "remote-ack"
EVENT_ACCEPTED = "accepted"
EVENTS = (EVENT_PREPARED, EVENT_REMOTE_ACK, EVENT_ACCEPTED)
JOURNAL_FILE_MODE = 0o600
MAX_JOURNAL_LINE_BYTES = 20 * 1024 * 1024


class JournalError(ValidationError):
    """The append-only journal is malformed or an operation conflicts."""


class AmbiguousWriteError(RuntimeError):
    """A target may have applied a write, but no safe acknowledgement exists."""


class ReplayMismatchError(RuntimeError):
    """Exact replay produced different IDs or read-after-write bytes."""


class _ExistingOperation(RuntimeError):
    """Internal lock-race signal carrying the already durable operation."""

    def __init__(self, state: "OperationState") -> None:
        super().__init__(state.operation_id)
        self.state = state


@dataclass(frozen=True)
class ReadVerification:
    """Exact projected objects observed by a post-ack read."""

    resulting_ids: tuple[str, ...]
    content_sha256: str


@dataclass
class OperationState:
    """Reconstructed state for one stable operation identity."""

    operation_id: str
    operation_sequence: int
    target_role: str
    plane: str
    payload: dict[str, Any]
    payload_sha256: str
    stage: str
    resulting_ids: tuple[str, ...]
    read_after_write_sha256: str | None

    @property
    def accepted(self) -> bool:
        """Return whether the durable post-ack acceptance record exists."""

        return self.stage == EVENT_ACCEPTED


@dataclass(frozen=True)
class AcceptedWrite:
    """One operation safe for acknowledgement or exact idempotent reuse."""

    operation_id: str
    operation_sequence: int
    plane: str
    payload_sha256: str
    resulting_ids: tuple[str, ...]
    read_after_write_sha256: str
    duplicate: bool


@dataclass(frozen=True)
class _JournalEvent:
    raw: dict[str, Any]
    event_sequence: int
    operation_sequence: int
    stage: str
    operation_id: str
    target_role: str
    plane: str
    payload_sha256: str
    resulting_ids: tuple[str, ...]
    remote_ack: bool
    read_after_write: bool
    read_digest: str | None


def stable_operation_id(cutover_id: str, client_id: str, operation_key: str) -> str:
    """Derive an identity stable across retry but independent of payload bytes.

    Keeping payload bytes out of the identity lets the journal detect a caller
    that reuses one logical operation key with divergent content.
    """

    identity = {
        "cutover_id": require_identifier(cutover_id, "cutover_id"),
        "client_id": require_identifier(client_id, "client_id"),
        "operation_key": require_identifier(operation_key, "operation_key"),
    }
    return f"op-{sha256_bytes(canonical_json_bytes(identity))}"


def _positive_integer(raw: object, field: str) -> int:
    if not isinstance(raw, int) or isinstance(raw, bool) or raw < 1:
        raise JournalError(f"{field} must be a positive integer")
    return raw


def _ids(raw: object, field: str, *, allow_empty: bool) -> tuple[str, ...]:
    if not isinstance(raw, list) or (not allow_empty and not raw):
        qualification = "a list" if allow_empty else "a non-empty list"
        raise JournalError(f"{field} must be {qualification}")
    values = tuple(
        require_identifier(value, f"{field}[{index}]") for index, value in enumerate(raw)
    )
    if len(set(values)) != len(values):
        raise JournalError(f"{field} contains duplicate IDs")
    return values


def _decode_journal_event(line: bytes, line_number: int) -> _JournalEvent:
    if len(line) > MAX_JOURNAL_LINE_BYTES:
        raise JournalError(f"journal line {line_number} exceeds its hard bound")
    try:
        parsed: object = json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise JournalError(f"journal line {line_number} is invalid JSON") from exc
    if not isinstance(parsed, dict):
        raise JournalError(f"journal line {line_number} must be an object")
    event = cast(dict[str, Any], parsed)
    common_fields = {
        "schema_version",
        "journal_type",
        "event_sequence",
        "operation_sequence",
        "event",
        "recorded_at",
        "operation_id",
        "target_role",
        "plane",
        "payload_sha256",
        "resulting_ids",
        "remote_ack",
        "read_after_write",
        "read_after_write_sha256",
    }
    stage = event.get("event")
    expected_fields = common_fields | ({"payload"} if stage == EVENT_PREPARED else set())
    if set(event) != expected_fields:
        raise JournalError(f"journal line {line_number} has unknown or missing fields")
    if event.get("schema_version") != JOURNAL_SCHEMA_VERSION:
        raise JournalError(f"journal line {line_number} has an unsupported schema")
    if event.get("journal_type") != JOURNAL_TYPE or stage not in EVENTS:
        raise JournalError(f"journal line {line_number} has the wrong type/event")
    target_role = require_identifier(event.get("target_role"), "target_role")
    if target_role not in {"source", "candidate"}:
        raise JournalError("target_role must be source or candidate")
    remote_ack = event.get("remote_ack")
    read_after_write = event.get("read_after_write")
    if not isinstance(remote_ack, bool) or not isinstance(read_after_write, bool):
        raise JournalError("journal acknowledgement flags must be booleans")
    read_digest_raw = event.get("read_after_write_sha256")
    read_digest = (
        None
        if read_digest_raw is None
        else require_sha256(read_digest_raw, "read_after_write_sha256")
    )
    require_utc_timestamp(event.get("recorded_at"), "recorded_at")
    return _JournalEvent(
        raw=event,
        event_sequence=_positive_integer(event.get("event_sequence"), "event_sequence"),
        operation_sequence=_positive_integer(event.get("operation_sequence"), "operation_sequence"),
        stage=cast(str, stage),
        operation_id=require_identifier(event.get("operation_id"), "operation_id"),
        target_role=target_role,
        plane=require_identifier(event.get("plane"), "plane"),
        payload_sha256=require_sha256(event.get("payload_sha256"), "payload_sha256"),
        resulting_ids=_ids(
            event.get("resulting_ids"),
            "resulting_ids",
            allow_empty=stage == EVENT_PREPARED,
        ),
        remote_ack=remote_ack,
        read_after_write=read_after_write,
        read_digest=read_digest,
    )


def _apply_prepared_event(
    event: _JournalEvent,
    operations: dict[str, OperationState],
    max_operation_sequence: int,
) -> int:
    if event.operation_id in operations or event.operation_sequence <= max_operation_sequence:
        raise JournalError("journal operation sequence is duplicate or out of order")
    payload = event.raw.get("payload")
    if not isinstance(payload, dict):
        raise JournalError("prepared journal record payload must be an object")
    if sha256_bytes(canonical_json_bytes(payload)) != event.payload_sha256:
        raise JournalError("prepared payload digest does not match payload")
    if event.resulting_ids or event.remote_ack or event.read_after_write or event.read_digest:
        raise JournalError("prepared record contains acknowledgement evidence")
    operations[event.operation_id] = OperationState(
        operation_id=event.operation_id,
        operation_sequence=event.operation_sequence,
        target_role=event.target_role,
        plane=event.plane,
        payload=cast(dict[str, Any], payload),
        payload_sha256=event.payload_sha256,
        stage=event.stage,
        resulting_ids=(),
        read_after_write_sha256=None,
    )
    return event.operation_sequence


def _apply_ack_event(event: _JournalEvent, operations: dict[str, OperationState]) -> None:
    prior = operations.get(event.operation_id)
    if prior is None:
        raise JournalError("journal acknowledgement has no prepared record")
    identity = (
        event.operation_sequence == prior.operation_sequence
        and event.target_role == prior.target_role
        and event.plane == prior.plane
        and event.payload_sha256 == prior.payload_sha256
    )
    if not identity:
        raise JournalError("journal operation identity changed across events")
    if event.stage == EVENT_REMOTE_ACK:
        valid = prior.stage == EVENT_PREPARED and event.remote_ack and not event.read_after_write
        if not valid or event.read_digest is not None:
            raise JournalError("remote acknowledgement is out of order")
    else:
        valid = prior.stage == EVENT_REMOTE_ACK and event.remote_ack and event.read_after_write
        if not valid or event.read_digest is None:
            raise JournalError("accepted event is out of order")
        if event.resulting_ids != prior.resulting_ids:
            raise JournalError("accepted resulting IDs differ from remote acknowledgement")
    prior.stage = event.stage
    prior.resulting_ids = event.resulting_ids
    prior.read_after_write_sha256 = event.read_digest


class AcceptedWriteJournal:
    """Append-only owner-only JSONL journal with a durable event sequence."""

    def __init__(self, path: Path) -> None:
        if not path.is_absolute():
            raise JournalError("journal path must be absolute")
        self.path = path.resolve(strict=False)

    def _open(self) -> int:
        if self.path.is_symlink():
            raise JournalError("journal must not be a symlink")
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        flags = os.O_RDWR | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(self.path, flags, JOURNAL_FILE_MODE)
        file_stat = os.fstat(descriptor)
        if not stat.S_ISREG(file_stat.st_mode):
            os.close(descriptor)
            raise JournalError("journal must be a regular file")
        if file_stat.st_uid != os.geteuid() or stat.S_IMODE(file_stat.st_mode) != JOURNAL_FILE_MODE:
            os.close(descriptor)
            raise JournalError("journal must be current-user owned with mode 0600")
        return descriptor

    @staticmethod
    def _read_locked(descriptor: int) -> bytes:
        size = os.fstat(descriptor).st_size
        if size > JSON_READ_LIMIT_BYTES:
            raise JournalError(f"journal exceeds {JSON_READ_LIMIT_BYTES} bytes")
        os.lseek(descriptor, 0, os.SEEK_SET)
        chunks: list[bytes] = []
        remaining = size
        while remaining:
            chunk = os.read(descriptor, min(remaining, 1024 * 1024))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    @staticmethod
    def _parse(raw: bytes) -> tuple[list[dict[str, Any]], dict[str, OperationState]]:
        if raw and not raw.endswith(b"\n"):
            raise JournalError("journal has an incomplete trailing record")
        events: list[dict[str, Any]] = []
        operations: dict[str, OperationState] = {}
        max_operation_sequence = 0
        for line_number, line in enumerate(raw.splitlines(), start=1):
            event = _decode_journal_event(line, line_number)
            if event.event_sequence != line_number:
                raise JournalError("journal event sequence is not contiguous")
            if event.stage == EVENT_PREPARED:
                max_operation_sequence = _apply_prepared_event(
                    event, operations, max_operation_sequence
                )
            else:
                _apply_ack_event(event, operations)
            events.append(event.raw)
        return events, operations

    def snapshot(self) -> tuple[list[dict[str, Any]], dict[str, OperationState]]:
        """Read and fully validate the journal under an exclusive file lock."""

        descriptor = self._open()
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            return self._parse(self._read_locked(descriptor))
        finally:
            os.close(descriptor)

    def _append(self, build: Any) -> OperationState:
        descriptor = self._open()
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            events, operations = self._parse(self._read_locked(descriptor))
            record = build(events, operations)
            payload = canonical_json_bytes(record)
            if len(payload) > MAX_JOURNAL_LINE_BYTES:
                raise JournalError("journal record exceeds its hard bound")
            view = memoryview(payload)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("short append to accepted-write journal")
                view = view[written:]
            os.fsync(descriptor)
            directory_fd = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            _events, updated = self._parse(self._read_locked(descriptor))
            return updated[record["operation_id"]]
        finally:
            os.close(descriptor)

    def prepare(
        self,
        *,
        operation_id: str,
        target_role: str,
        plane: str,
        payload: Mapping[str, object],
    ) -> tuple[OperationState, bool]:
        """Fsync an intent or return the existing identical operation."""

        normalized_payload = dict(payload)
        payload_sha256 = sha256_bytes(canonical_json_bytes(normalized_payload))
        operation_id = require_identifier(operation_id, "operation_id")
        plane = require_identifier(plane, "plane")
        if target_role not in {"source", "candidate"}:
            raise JournalError("target_role must be source or candidate")
        created = False

        def build(
            events: list[dict[str, Any]], operations: dict[str, OperationState]
        ) -> dict[str, Any]:
            nonlocal created
            prior = operations.get(operation_id)
            if prior is not None:
                if (
                    prior.target_role != target_role
                    or prior.plane != plane
                    or prior.payload_sha256 != payload_sha256
                ):
                    raise JournalError("stable operation ID was reused with divergent input")
                raise _ExistingOperation(prior)
            created = True
            return {
                "schema_version": JOURNAL_SCHEMA_VERSION,
                "journal_type": JOURNAL_TYPE,
                "event_sequence": len(events) + 1,
                "operation_sequence": len(operations) + 1,
                "event": EVENT_PREPARED,
                "recorded_at": utc_now(),
                "operation_id": operation_id,
                "target_role": target_role,
                "plane": plane,
                "payload": normalized_payload,
                "payload_sha256": payload_sha256,
                "resulting_ids": [],
                "remote_ack": False,
                "read_after_write": False,
                "read_after_write_sha256": None,
            }

        if self.path.exists():
            _events, operations = self.snapshot()
            prior = operations.get(operation_id)
            if prior is not None:
                if (
                    prior.target_role != target_role
                    or prior.plane != plane
                    or prior.payload_sha256 != payload_sha256
                ):
                    raise JournalError("stable operation ID was reused with divergent input")
                return prior, False
        try:
            state = self._append(build)
        except _ExistingOperation as existing:
            return existing.state, False
        return state, created

    def record_remote_ack(self, operation_id: str, resulting_ids: Iterable[str]) -> OperationState:
        """Fsync the target's stable resulting IDs."""

        ids = _ids(list(resulting_ids), "resulting_ids", allow_empty=False)

        def build(
            events: list[dict[str, Any]], operations: dict[str, OperationState]
        ) -> dict[str, Any]:
            prior = operations.get(operation_id)
            if prior is None or prior.stage != EVENT_PREPARED:
                raise JournalError("remote acknowledgement requires a pending prepared operation")
            return {
                "schema_version": JOURNAL_SCHEMA_VERSION,
                "journal_type": JOURNAL_TYPE,
                "event_sequence": len(events) + 1,
                "operation_sequence": prior.operation_sequence,
                "event": EVENT_REMOTE_ACK,
                "recorded_at": utc_now(),
                "operation_id": prior.operation_id,
                "target_role": prior.target_role,
                "plane": prior.plane,
                "payload_sha256": prior.payload_sha256,
                "resulting_ids": list(ids),
                "remote_ack": True,
                "read_after_write": False,
                "read_after_write_sha256": None,
            }

        return self._append(build)

    def record_accepted(self, operation_id: str, verification: ReadVerification) -> OperationState:
        """Fsync post-ack read evidence, making the operation acknowledgeable."""

        def build(
            events: list[dict[str, Any]], operations: dict[str, OperationState]
        ) -> dict[str, Any]:
            prior = operations.get(operation_id)
            if prior is None or prior.stage != EVENT_REMOTE_ACK:
                raise JournalError("acceptance requires a durable remote acknowledgement")
            if prior.resulting_ids != verification.resulting_ids:
                raise JournalError("post-ack read IDs differ from acknowledged IDs")
            return {
                "schema_version": JOURNAL_SCHEMA_VERSION,
                "journal_type": JOURNAL_TYPE,
                "event_sequence": len(events) + 1,
                "operation_sequence": prior.operation_sequence,
                "event": EVENT_ACCEPTED,
                "recorded_at": utc_now(),
                "operation_id": prior.operation_id,
                "target_role": prior.target_role,
                "plane": prior.plane,
                "payload_sha256": prior.payload_sha256,
                "resulting_ids": list(prior.resulting_ids),
                "remote_ack": True,
                "read_after_write": True,
                "read_after_write_sha256": verification.content_sha256,
            }

        return self._append(build)


class HubOperationAdapter:
    """Map configured operation planes onto the existing HTTP admin client."""

    def __init__(
        self, client: MemoryAdminClient, specs: Mapping[str, OperationSpec], target_role: str
    ) -> None:
        if target_role not in {"source", "candidate"}:
            raise ValueError("target_role must be source or candidate")
        self.client = client
        self.specs = dict(specs)
        self.target_role = target_role

    @staticmethod
    def _at_path(payload: Mapping[str, Any], path: tuple[str, ...], field: str) -> object:
        current: object = payload
        for part in path:
            if not isinstance(current, dict) or part not in current:
                raise JournalError(f"hub payload lacks configured {field} path")
            current = current[part]
        return current

    def write(
        self, plane: str, payload: Mapping[str, object], operation_id: str
    ) -> tuple[str, ...]:
        """Attempt one idempotency-keyed write exactly once."""

        spec = self.specs.get(plane)
        if spec is None:
            raise JournalError(f"unknown operation plane: {plane}")
        arguments = dict(payload)
        if spec.operation_id_argument in arguments:
            raise JournalError("payload must not supply the execution-owner operation ID field")
        arguments[spec.operation_id_argument] = operation_id
        response = self.client.call_tool(spec.write_tool, arguments).payload
        raw_ids = self._at_path(response, spec.resulting_ids_path, "resulting IDs")
        if spec.resulting_ids_mode == "scalar":
            raw_ids = [raw_ids]
        return _ids(raw_ids, "hub resulting IDs", allow_empty=False)

    @staticmethod
    def _read_argument(spec: OperationSpec, ids: tuple[str, ...]) -> object:
        if spec.read_ids_argument_mode != "scalar":
            return list(ids)
        if len(ids) != 1:
            raise JournalError("configured scalar read requires exactly one resulting ID")
        return ids[0]

    def read_after_write(self, plane: str, resulting_ids: Iterable[str]) -> ReadVerification:
        """Read and hash the exact configured stable projection for resulting IDs."""

        spec = self.specs.get(plane)
        if spec is None:
            raise JournalError(f"unknown operation plane: {plane}")
        ids = _ids(list(resulting_ids), "read resulting IDs", allow_empty=False)
        response = self.client.call_tool(
            spec.read_tool, {spec.read_ids_argument: self._read_argument(spec, ids)}
        ).payload
        raw_items = self._at_path(response, spec.read_items_path, "read items")
        if spec.read_items_mode == "single":
            raw_items = [raw_items]
        if not isinstance(raw_items, list):
            raise JournalError("configured read items path must resolve to a list")
        by_id: dict[str, dict[str, Any]] = {}
        for index, raw_item in enumerate(raw_items):
            if not isinstance(raw_item, dict):
                raise JournalError(f"read item {index} must be an object")
            item = cast(dict[str, Any], raw_item)
            item_id = require_identifier(item.get(spec.read_item_id_field), f"read item {index} ID")
            if item_id in by_id:
                raise JournalError("read-after-write returned duplicate IDs")
            missing = [field for field in spec.read_projection_fields if field not in item]
            if missing:
                raise JournalError(f"read item {index} lacks projected fields: {missing}")
            by_id[item_id] = {field: item[field] for field in spec.read_projection_fields}
        if set(by_id) != set(ids):
            raise JournalError("read-after-write IDs do not exactly match acknowledged IDs")
        projected = [by_id[item_id] for item_id in ids]
        return ReadVerification(
            resulting_ids=ids,
            content_sha256=sha256_bytes(canonical_json_bytes(projected)),
        )


class JournaledWriter:
    """One-target writer; this class has no dual-write or fallback branch."""

    def __init__(
        self,
        journal: AcceptedWriteJournal,
        adapter: HubOperationAdapter,
        *,
        fault_gate_passed: bool,
    ) -> None:
        self.journal = journal
        self.adapter = adapter
        self.fault_gate_passed = fault_gate_passed

    @staticmethod
    def _accepted(state: OperationState, *, duplicate: bool) -> AcceptedWrite:
        if not state.accepted or state.read_after_write_sha256 is None:
            raise JournalError("operation is not accepted")
        return AcceptedWrite(
            operation_id=state.operation_id,
            operation_sequence=state.operation_sequence,
            plane=state.plane,
            payload_sha256=state.payload_sha256,
            resulting_ids=state.resulting_ids,
            read_after_write_sha256=state.read_after_write_sha256,
            duplicate=duplicate,
        )

    def execute(
        self,
        *,
        operation_id: str,
        plane: str,
        payload: Mapping[str, object],
        recover_pending: bool = False,
        expected_resulting_ids: tuple[str, ...] | None = None,
        expected_read_sha256: str | None = None,
    ) -> AcceptedWrite:
        """Execute or recover one exact operation and acknowledge only after fsync."""

        state, created = self.journal.prepare(
            operation_id=operation_id,
            target_role=self.adapter.target_role,
            plane=plane,
            payload=payload,
        )
        if state.accepted:
            accepted = self._accepted(state, duplicate=True)
            self._verify_expected(accepted, expected_resulting_ids, expected_read_sha256)
            return accepted
        if not created and not recover_pending:
            raise AmbiguousWriteError(
                "operation has a pending ambiguous outcome; explicit gated recovery is required"
            )
        if recover_pending and not self.fault_gate_passed:
            raise AmbiguousWriteError("pending recovery requires a passed fault gate")

        if state.stage == EVENT_PREPARED:
            try:
                resulting_ids = self.adapter.write(plane, payload, operation_id)
            except AdminClientError as exc:
                raise AmbiguousWriteError(
                    "write outcome is ambiguous and remains pending in the journal"
                ) from exc
            state = self.journal.record_remote_ack(operation_id, resulting_ids)
        if expected_resulting_ids is not None and state.resulting_ids != expected_resulting_ids:
            raise ReplayMismatchError("exact replay returned different resulting IDs")

        verification = self.adapter.read_after_write(plane, state.resulting_ids)
        if expected_read_sha256 is not None and verification.content_sha256 != expected_read_sha256:
            raise ReplayMismatchError(
                "exact replay post-ack content differs from the source journal"
            )
        state = self.journal.record_accepted(operation_id, verification)
        accepted = self._accepted(state, duplicate=not created)
        self._verify_expected(accepted, expected_resulting_ids, expected_read_sha256)
        return accepted

    @staticmethod
    def _verify_expected(
        accepted: AcceptedWrite,
        expected_ids: tuple[str, ...] | None,
        expected_digest: str | None,
    ) -> None:
        if expected_ids is not None and accepted.resulting_ids != expected_ids:
            raise ReplayMismatchError("accepted replay IDs differ from the source journal")
        if expected_digest is not None and accepted.read_after_write_sha256 != expected_digest:
            raise ReplayMismatchError("accepted replay content differs from the source journal")
