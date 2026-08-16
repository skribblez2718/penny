"""Receipted MEM-06 canary authority state machine and write coordinator."""

from __future__ import annotations

import fcntl
import os
import stat
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Mapping, cast

from statemachine import State, StateMachine
from statemachine.exceptions import TransitionNotAllowed

from .accepted_write_journal import (
    AcceptedWrite,
    AcceptedWriteJournal,
    HubOperationAdapter,
    JournaledWriter,
    stable_operation_id,
)
from .common import (
    ValidationError,
    canonical_json_bytes,
    ensure_owner_only,
    load_json_object,
    require_identifier,
    require_sha256,
    require_utc_timestamp,
    sha256_file,
    utc_now,
)
from .cutover_config import CutoverConfig
from .cutover_evidence import (
    EvidenceBundle,
    consume_one_time_approval,
    load_evidence_bundle,
    validate_qualification_bundle,
    validate_transition_bundle,
)
from .replay_reconcile import accepted_write_count

CUTOVER_STATE_SCHEMA_VERSION = 1
CUTOVER_STATE_TYPE = "memory-canary-cutover-state"
STATE_FILE_MODE = 0o600


class CanaryCutoverMachine(StateMachine):
    """Fail-closed authority progression; no fallback or downgrade transition exists."""

    draft = State(initial=True)
    qualified = State()
    drained = State()
    delta_reconciled = State()
    canary = State()
    reconciled = State()
    expanded = State()
    rolled_back = State(final=True)

    qualify = draft.to(qualified)
    drain = qualified.to(drained)
    final_delta = drained.to(delta_reconciled)
    start_canary = delta_reconciled.to(canary)
    reconcile = canary.to(reconciled)
    expand = reconciled.to(expanded)
    rollback_before_write = (
        qualified.to(rolled_back)
        | drained.to(rolled_back)
        | delta_reconciled.to(rolled_back)
        | canary.to(rolled_back)
        | reconciled.to(rolled_back)
        | expanded.to(rolled_back)
    )
    rollback_after_write = (
        canary.to(rolled_back) | reconciled.to(rolled_back) | expanded.to(rolled_back)
    )


@dataclass(frozen=True)
class TransitionRecord:
    """Hash-bound transition evidence retained in canonical state."""

    sequence: int
    transition: str
    from_state: str
    to_state: str
    evidence_sha256: str
    approval_consumption_sha256: str
    applied_at: str

    def as_dict(self) -> dict[str, Any]:
        """Serialize one state transition."""

        return {
            "sequence": self.sequence,
            "transition": self.transition,
            "from_state": self.from_state,
            "to_state": self.to_state,
            "evidence_sha256": self.evidence_sha256,
            "approval_consumption_sha256": self.approval_consumption_sha256,
            "applied_at": self.applied_at,
        }


@dataclass(frozen=True)
class CutoverState:
    """Atomic client-authority snapshot consumed by canary write clients."""

    cutover_id: str
    config_sha256: str
    state: str
    authority_role: str
    admitted_client_ids: tuple[str, ...]
    blocked_client_ids: tuple[str, ...]
    fallback_allowed: bool
    post_ack_read_required: bool
    fault_gate_passed: bool
    history: tuple[TransitionRecord, ...]
    updated_at: str

    def as_dict(self) -> dict[str, Any]:
        """Serialize the authoritative state and routing policy."""

        return {
            "schema_version": CUTOVER_STATE_SCHEMA_VERSION,
            "state_type": CUTOVER_STATE_TYPE,
            "cutover_id": self.cutover_id,
            "config_sha256": self.config_sha256,
            "state": self.state,
            "authority_role": self.authority_role,
            "admitted_client_ids": list(self.admitted_client_ids),
            "blocked_client_ids": list(self.blocked_client_ids),
            "fallback_allowed": self.fallback_allowed,
            "post_ack_read_required": self.post_ack_read_required,
            "fault_gate_passed": self.fault_gate_passed,
            "history": [record.as_dict() for record in self.history],
            "updated_at": self.updated_at,
        }


def _state_policy(config: CutoverConfig, state: str) -> tuple[str, tuple[str, ...]]:
    if state in {"qualified"}:
        return "source", config.approved_client_ids
    if state in {"drained", "delta_reconciled"}:
        return "source", ()
    if state in {"canary", "reconciled"}:
        return "candidate", config.canary_client_ids
    if state == "expanded":
        return "candidate", config.approved_client_ids
    if state == "rolled_back":
        return "source", config.approved_client_ids
    return "none", ()


@contextmanager
def _control_lock(config: CutoverConfig) -> Iterator[None]:
    path = config.control_lock_path
    if path.is_symlink():
        raise ValidationError("cutover control lock must not be a symlink")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, STATE_FILE_MODE)
    try:
        file_stat = os.fstat(descriptor)
        if (
            not stat.S_ISREG(file_stat.st_mode)
            or file_stat.st_uid != os.geteuid()
            or stat.S_IMODE(file_stat.st_mode) != STATE_FILE_MODE
        ):
            raise ValidationError("cutover control lock must be current-user owned with mode 0600")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def _atomic_replace_state(path: Path, state: CutoverState) -> None:
    if path.is_symlink():
        raise ValidationError("cutover state path must not be a symlink")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.exists():
        ensure_owner_only(path, "cutover state")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        payload = canonical_json_bytes(state.as_dict())
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), STATE_FILE_MODE)
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def _identifier_tuple(raw: object, field: str) -> tuple[str, ...]:
    if not isinstance(raw, list):
        raise ValidationError(f"{field} must be a list")
    values = tuple(
        require_identifier(value, f"{field}[{index}]") for index, value in enumerate(raw)
    )
    if len(set(values)) != len(values):
        raise ValidationError(f"{field} contains duplicates")
    return values


def _parse_history(raw_history: object) -> tuple[TransitionRecord, ...]:
    if not isinstance(raw_history, list):
        raise ValidationError("cutover state history must be a list")
    history: list[TransitionRecord] = []
    fields = {
        "sequence",
        "transition",
        "from_state",
        "to_state",
        "evidence_sha256",
        "approval_consumption_sha256",
        "applied_at",
    }
    for index, raw in enumerate(raw_history):
        if not isinstance(raw, dict) or set(raw) != fields:
            raise ValidationError(f"cutover history {index} is invalid")
        if raw["sequence"] != index + 1:
            raise ValidationError("cutover history sequence is not contiguous")
        history.append(
            TransitionRecord(
                sequence=index + 1,
                transition=require_identifier(raw["transition"], "history.transition"),
                from_state=require_identifier(raw["from_state"], "history.from_state"),
                to_state=require_identifier(raw["to_state"], "history.to_state"),
                evidence_sha256=require_sha256(raw["evidence_sha256"], "history.evidence_sha256"),
                approval_consumption_sha256=require_sha256(
                    raw["approval_consumption_sha256"],
                    "history.approval_consumption_sha256",
                ),
                applied_at=require_utc_timestamp(raw["applied_at"], "history.applied_at"),
            )
        )
    return tuple(history)


def load_cutover_state(config: CutoverConfig) -> CutoverState:
    """Load canonical state or return an in-memory uninitialized draft."""

    if not config.state_path.exists():
        return CutoverState(
            cutover_id=config.cutover_id,
            config_sha256=config.config_sha256,
            state="draft",
            authority_role="none",
            admitted_client_ids=(),
            blocked_client_ids=config.approved_client_ids,
            fallback_allowed=False,
            post_ack_read_required=True,
            fault_gate_passed=False,
            history=(),
            updated_at=utc_now(),
        )
    ensure_owner_only(config.state_path, "cutover state")
    document = load_json_object(config.state_path)
    required = {
        "schema_version",
        "state_type",
        "cutover_id",
        "config_sha256",
        "state",
        "authority_role",
        "admitted_client_ids",
        "blocked_client_ids",
        "fallback_allowed",
        "post_ack_read_required",
        "fault_gate_passed",
        "history",
        "updated_at",
    }
    if set(document) != required:
        raise ValidationError("cutover state has unknown or missing fields")
    if (
        document.get("schema_version") != CUTOVER_STATE_SCHEMA_VERSION
        or document.get("state_type") != CUTOVER_STATE_TYPE
        or document.get("cutover_id") != config.cutover_id
        or document.get("config_sha256") != config.config_sha256
    ):
        raise ValidationError("cutover state identity/schema mismatch")
    state_name = require_identifier(document.get("state"), "state")
    authority_role = require_identifier(document.get("authority_role"), "authority_role")
    admitted = _identifier_tuple(document.get("admitted_client_ids"), "admitted_client_ids")
    blocked = _identifier_tuple(document.get("blocked_client_ids"), "blocked_client_ids")
    if set(admitted) | set(blocked) != set(config.approved_client_ids) or set(admitted) & set(
        blocked
    ):
        raise ValidationError("cutover state client partition does not match approved clients")
    expected_authority, expected_admitted = _state_policy(config, state_name)
    if authority_role != expected_authority or admitted != expected_admitted:
        raise ValidationError("cutover state authority/client policy does not match FSM state")
    if document.get("fallback_allowed") is not False:
        raise ValidationError("cutover state must prohibit fallback")
    if document.get("post_ack_read_required") is not True:
        raise ValidationError("cutover state must require post-ack reads")
    fault_gate_passed = document.get("fault_gate_passed")
    if not isinstance(fault_gate_passed, bool):
        raise ValidationError("fault_gate_passed must be boolean")
    history = _parse_history(document.get("history"))
    _validate_history_chain(history, state_name)
    if fault_gate_passed != any(record.transition == "qualify" for record in history):
        raise ValidationError("fault-gate state is not derived from qualification history")
    require_utc_timestamp(document.get("updated_at"), "updated_at")
    return CutoverState(
        cutover_id=config.cutover_id,
        config_sha256=config.config_sha256,
        state=state_name,
        authority_role=authority_role,
        admitted_client_ids=admitted,
        blocked_client_ids=blocked,
        fallback_allowed=False,
        post_ack_read_required=True,
        fault_gate_passed=fault_gate_passed,
        history=history,
        updated_at=cast(str, document["updated_at"]),
    )


TRANSITION_STAGE = {
    "qualify": "qualification",
    "drain": "drain",
    "final-delta": "final-delta",
    "start-canary": "canary",
    "reconcile": "reconcile",
    "expand": "expand",
    "rollback-before-write": "rollback-before-write",
    "rollback-after-write": "rollback-after-write",
}
TRANSITION_EVENT = {
    "qualify": "qualify",
    "drain": "drain",
    "final-delta": "final_delta",
    "start-canary": "start_canary",
    "reconcile": "reconcile",
    "expand": "expand",
    "rollback-before-write": "rollback_before_write",
    "rollback-after-write": "rollback_after_write",
}


def _validate_history_chain(history: tuple[TransitionRecord, ...], state_name: str) -> None:
    machine = CanaryCutoverMachine()
    for record in history:
        if record.transition not in TRANSITION_EVENT:
            raise ValidationError("cutover history contains an unknown transition")
        if record.from_state != machine.current_state_value:
            raise ValidationError("cutover history from_state is not contiguous")
        try:
            machine.send(TRANSITION_EVENT[record.transition])
        except TransitionNotAllowed as exc:
            raise ValidationError("cutover history contains an illegal transition") from exc
        if record.to_state != machine.current_state_value:
            raise ValidationError("cutover history to_state does not match the FSM")
    if machine.current_state_value != state_name:
        raise ValidationError("cutover history does not derive the current state")


class CanaryCutoverController:
    """Validate evidence/capability and atomically change canary authority."""

    def __init__(self, config: CutoverConfig) -> None:
        self.config = config
        self.journal = AcceptedWriteJournal(config.journal_path)

    def _validate_bundle(self, transition: str, bundle: EvidenceBundle) -> int:
        writes = accepted_write_count(self.journal)
        operation_count = 0
        if self.journal.path.exists():
            _events, operations = self.journal.snapshot()
            operation_count = len(operations)
        no_candidate_operation_stages = {
            "qualify",
            "drain",
            "final-delta",
            "start-canary",
            "rollback-before-write",
        }
        if transition in no_candidate_operation_stages and operation_count:
            raise ValidationError(
                f"{transition} requires zero candidate journal operations, including pending"
            )
        if transition == "qualify":
            validate_qualification_bundle(bundle, self.config)
        else:
            journal_digest = sha256_file(self.journal.path) if self.journal.path.exists() else None
            validate_transition_bundle(
                bundle,
                self.config,
                journal_sha256=journal_digest,
                accepted_write_count=writes,
            )
        return writes

    def dry_run(self, transition: str, evidence_path: Path) -> dict[str, Any]:
        """Validate a transition and its evidence without consuming or writing."""

        if transition not in TRANSITION_STAGE:
            raise ValidationError(f"unknown transition: {transition}")
        state = load_cutover_state(self.config)
        bundle = load_evidence_bundle(evidence_path, self.config, TRANSITION_STAGE[transition])
        writes = self._validate_bundle(transition, bundle)
        machine = CanaryCutoverMachine(start_value=state.state)
        try:
            machine.send(TRANSITION_EVENT[transition])
        except TransitionNotAllowed as exc:
            raise ValidationError(
                f"transition {transition} is not allowed from {state.state}"
            ) from exc
        return {
            "transition": transition,
            "from_state": state.state,
            "to_state": machine.current_state_value,
            "evidence_sha256": bundle.sha256,
            "accepted_write_count": writes,
            "would_mutate": False,
        }

    def apply(
        self,
        transition: str,
        evidence_path: Path,
        approval_path: Path,
        consumption_path: Path,
    ) -> CutoverState:
        """Consume one capability, then publish one complete authority snapshot."""

        with _control_lock(self.config):
            preview = self.dry_run(transition, evidence_path)
            state = load_cutover_state(self.config)
            bundle = load_evidence_bundle(evidence_path, self.config, TRANSITION_STAGE[transition])
            consume_one_time_approval(
                approval_path,
                consumption_path,
                self.config,
                action=transition,
                evidence_sha256=bundle.sha256,
            )
            to_state = str(preview["to_state"])
            authority, admitted = _state_policy(self.config, to_state)
            blocked = tuple(
                client_id
                for client_id in self.config.approved_client_ids
                if client_id not in set(admitted)
            )
            applied_at = utc_now()
            record = TransitionRecord(
                sequence=len(state.history) + 1,
                transition=transition,
                from_state=state.state,
                to_state=to_state,
                evidence_sha256=bundle.sha256,
                approval_consumption_sha256=sha256_file(consumption_path),
                applied_at=applied_at,
            )
            updated = CutoverState(
                cutover_id=self.config.cutover_id,
                config_sha256=self.config.config_sha256,
                state=to_state,
                authority_role=authority,
                admitted_client_ids=admitted,
                blocked_client_ids=blocked,
                fallback_allowed=False,
                post_ack_read_required=True,
                fault_gate_passed=(state.fault_gate_passed or transition == "qualify"),
                history=state.history + (record,),
                updated_at=applied_at,
            )
            _atomic_replace_state(self.config.state_path, updated)
            return updated


class CanaryWriteCoordinator:
    """Route one admitted client to candidate only, with no fallback/dual write."""

    def __init__(self, config: CutoverConfig, candidate_adapter: HubOperationAdapter) -> None:
        if candidate_adapter.target_role != "candidate":
            raise ValueError("canary write coordinator requires the candidate adapter")
        self.config = config
        self.adapter = candidate_adapter
        self.journal = AcceptedWriteJournal(config.journal_path)

    def write(
        self,
        *,
        client_id: str,
        operation_key: str,
        plane: str,
        payload: Mapping[str, object],
    ) -> AcceptedWrite:
        """Accept one candidate write only after journal fsync and exact read."""

        client_id = require_identifier(client_id, "client_id")
        state = load_cutover_state(self.config)
        if state.state not in {"canary", "expanded"}:
            raise ValidationError("candidate writes are not admitted in the current cutover state")
        if state.authority_role != "candidate" or client_id not in state.admitted_client_ids:
            raise ValidationError("client is not admitted to the candidate authority")
        if state.fallback_allowed or not state.post_ack_read_required:
            raise ValidationError(
                "candidate policy must prohibit fallback and require post-ack read"
            )
        operation_id = stable_operation_id(self.config.cutover_id, client_id, operation_key)
        writer = JournaledWriter(
            self.journal,
            self.adapter,
            fault_gate_passed=state.fault_gate_passed,
        )
        return writer.execute(
            operation_id=operation_id,
            plane=plane,
            payload=payload,
        )


def cutover_status(config: CutoverConfig) -> dict[str, Any]:
    """Return machine-readable state/journal status without contacting either hub."""

    state = load_cutover_state(config)
    if config.journal_path.exists():
        _events, operations = AcceptedWriteJournal(config.journal_path).snapshot()
        accepted = sum(1 for operation in operations.values() if operation.accepted)
        pending = sum(1 for operation in operations.values() if not operation.accepted)
        journal_digest: str | None = sha256_file(config.journal_path)
    else:
        accepted = 0
        pending = 0
        journal_digest = None
    cycles_passed = any(record.transition == "expand" for record in state.history)
    cycle_status = "PASS" if cycles_passed else "NOT RUN"
    return {
        "cutover_id": config.cutover_id,
        "state": state.state,
        "authority_role": state.authority_role,
        "admitted_client_ids": list(state.admitted_client_ids),
        "blocked_client_ids": list(state.blocked_client_ids),
        "fallback_allowed": state.fallback_allowed,
        "post_ack_read_required": state.post_ack_read_required,
        "fault_gate_passed": state.fault_gate_passed,
        "accepted_write_count": accepted,
        "pending_write_count": pending,
        "journal_sha256": journal_digest,
        "transition_count": len(state.history),
        "live_peak_cycle": cycle_status,
        "maintenance_cycle": cycle_status,
    }
