"""Read-only reconciliation and exact idempotent journal replay tooling."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .accepted_write_journal import (
    AcceptedWriteJournal,
    HubOperationAdapter,
    JournaledWriter,
    OperationState,
    ReplayMismatchError,
)
from .common import ValidationError, atomic_write_json, require_absolute_path, sha256_file, utc_now
from .cutover_evidence import (
    ACCEPTED_RECONCILIATION_TYPE,
    EVIDENCE_SCHEMA_VERSION,
    REPLAY_RECEIPT_TYPE,
)


def journal_operations(journal: AcceptedWriteJournal) -> list[OperationState]:
    """Return validated operations in their durable operation sequence."""

    _events, operations = journal.snapshot()
    return sorted(operations.values(), key=lambda item: item.operation_sequence)


def accepted_write_count(journal: AcceptedWriteJournal) -> int:
    """Count only operations with durable ack and post-ack read evidence."""

    if not journal.path.exists():
        return 0
    return sum(1 for operation in journal_operations(journal) if operation.accepted)


def reconcile_accepted_writes(
    journal: AcceptedWriteJournal,
    adapter: HubOperationAdapter,
    output: Path,
) -> dict[str, Any]:
    """Read every accepted resulting object and compare its exact projection."""

    destination = require_absolute_path(str(output), "output", must_exist=False)
    operations = journal_operations(journal)
    pending = [operation for operation in operations if not operation.accepted]
    mismatches: list[dict[str, Any]] = []
    reconciled_count = 0
    for operation in operations:
        if not operation.accepted:
            continue
        try:
            verification = adapter.read_after_write(operation.plane, operation.resulting_ids)
            if verification.resulting_ids != operation.resulting_ids:
                mismatches.append(
                    {
                        "operation_id": operation.operation_id,
                        "reason": "resulting-ids-changed",
                    }
                )
            elif verification.content_sha256 != operation.read_after_write_sha256:
                mismatches.append(
                    {
                        "operation_id": operation.operation_id,
                        "reason": "read-after-write-digest-changed",
                    }
                )
            else:
                reconciled_count += 1
        except Exception as exc:  # receipt the typed failure without payload content
            mismatches.append(
                {
                    "operation_id": operation.operation_id,
                    "reason": f"read-failed:{type(exc).__name__}",
                }
            )
    journal_digest = sha256_file(journal.path)
    receipt: dict[str, Any] = {
        "schema_version": EVIDENCE_SCHEMA_VERSION,
        "receipt_type": ACCEPTED_RECONCILIATION_TYPE,
        "reconciled_at": utc_now(),
        "target_role": adapter.target_role,
        "journal_sha256": journal_digest,
        "operation_count": len(operations),
        "accepted_count": sum(1 for operation in operations if operation.accepted),
        "pending_count": len(pending),
        "pending_operation_ids": [operation.operation_id for operation in pending],
        "reconciled_count": reconciled_count,
        "mismatches": mismatches,
        "exact": not pending and not mismatches,
    }
    atomic_write_json(destination, receipt)
    return receipt


def replay_accepted_writes(
    source_journal: AcceptedWriteJournal,
    replay_journal: AcceptedWriteJournal,
    target_adapter: HubOperationAdapter,
    output: Path,
    *,
    fault_gate_passed: bool,
) -> dict[str, Any]:
    """Replay each accepted payload exactly once in source journal sequence."""

    if target_adapter.target_role != "source":
        raise ValidationError("rollback replay target must be the compatible restored source")
    destination = require_absolute_path(str(output), "output", must_exist=False)
    source_operations = journal_operations(source_journal)
    pending = [operation.operation_id for operation in source_operations if not operation.accepted]
    if pending:
        raise ValidationError(f"source journal contains ambiguous pending operations: {pending}")
    writer = JournaledWriter(
        replay_journal,
        target_adapter,
        fault_gate_passed=fault_gate_passed,
    )
    failures: list[dict[str, str]] = []
    duplicate_count = 0
    replayed_count = 0
    for operation in source_operations:
        try:
            result = writer.execute(
                operation_id=operation.operation_id,
                plane=operation.plane,
                payload=operation.payload,
                recover_pending=True,
                expected_resulting_ids=operation.resulting_ids,
                expected_read_sha256=operation.read_after_write_sha256,
            )
            if result.operation_sequence != operation.operation_sequence:
                raise ReplayMismatchError("exact replay operation sequence differs")
            duplicate_count += int(result.duplicate)
            replayed_count += 1
        except Exception as exc:  # durable failure receipt; never claim exactness
            failures.append(
                {
                    "operation_id": operation.operation_id,
                    "reason": type(exc).__name__,
                }
            )
            break
    exact = replayed_count == len(source_operations) and not failures
    receipt: dict[str, Any] = {
        "schema_version": EVIDENCE_SCHEMA_VERSION,
        "receipt_type": REPLAY_RECEIPT_TYPE,
        "replayed_at": utc_now(),
        "target_role": target_adapter.target_role,
        "source_journal_sha256": sha256_file(source_journal.path),
        "replay_journal_sha256": sha256_file(replay_journal.path),
        "operation_count": len(source_operations),
        "replayed_count": replayed_count,
        "duplicate_count": duplicate_count,
        "failures": failures,
        "package_downgrade": False,
        "exact": exact,
    }
    atomic_write_json(destination, receipt)
    return receipt
