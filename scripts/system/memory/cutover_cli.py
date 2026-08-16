"""Operator CLI for MEM-05/MEM-06 planning, state, reconciliation, and replay."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence

from .accepted_write_journal import AcceptedWriteJournal, HubOperationAdapter
from .admin_client import AdminClientError, MemoryAdminClient
from .canary_cutover import (
    TRANSITION_STAGE,
    CanaryCutoverController,
    cutover_status,
    load_cutover_state,
)
from .common import ValidationError, require_absolute_path, sha256_file
from .cutover_config import CutoverConfig, load_cutover_config
from .cutover_evidence import (
    consume_one_time_approval,
    load_evidence_bundle,
    validate_transition_bundle,
)
from .replay_reconcile import (
    accepted_write_count,
    journal_operations,
    reconcile_accepted_writes,
    replay_accepted_writes,
)
from .shadow_compare import run_shadow_comparison


def _print(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2))


def _adapter(config: CutoverConfig, role: str) -> HubOperationAdapter:
    hub = config.source if role == "source" else config.candidate
    client = MemoryAdminClient.from_hub_config(hub)
    return HubOperationAdapter(client, config.operation_specs, role)


def _plan(config: CutoverConfig) -> dict[str, Any]:
    return {
        "cutover_id": config.cutover_id,
        "config_sha256": config.config_sha256,
        "source": {
            "palace_id": config.source.palace_id,
            "config_sha256": config.source.config_sha256,
        },
        "candidate": {
            "palace_id": config.candidate.palace_id,
            "config_sha256": config.candidate.config_sha256,
        },
        "canary_client_ids": list(config.canary_client_ids),
        "approved_client_ids": list(config.approved_client_ids),
        "fallback_allowed": False,
        "post_ack_read_required": True,
        "transitions": list(TRANSITION_STAGE),
        "commands_are_non_mutating_by_default": True,
        "live_peak_cycle": "NOT RUN",
        "maintenance_cycle": "NOT RUN",
    }


def _replay_plan(journal: AcceptedWriteJournal) -> dict[str, Any]:
    operations = journal_operations(journal)
    return {
        "source_journal_sha256": sha256_file(journal.path),
        "operation_count": len(operations),
        "accepted_operation_ids": [
            operation.operation_id for operation in operations if operation.accepted
        ],
        "pending_operation_ids": [
            operation.operation_id for operation in operations if not operation.accepted
        ],
        "target_role": "source",
        "package_downgrade": False,
        "would_mutate": False,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Receipted MEM-05/MEM-06 shadow, canary, replay, and rollback tooling"
    )
    parser.add_argument("--config", required=True, type=Path, help="explicit cutover config")
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("plan", help="show the static no-live-action plan")
    commands.add_parser("status", help="read local state/journal without contacting a hub")

    dry = commands.add_parser("dry-run", help="validate one state transition without mutation")
    dry.add_argument("--transition", required=True, choices=tuple(TRANSITION_STAGE))
    dry.add_argument("--evidence", required=True, type=Path)

    apply = commands.add_parser("apply", help="consume one capability and apply one transition")
    apply.add_argument("--transition", required=True, choices=tuple(TRANSITION_STAGE))
    apply.add_argument("--evidence", required=True, type=Path)
    apply.add_argument("--approval-receipt", required=True, type=Path)
    apply.add_argument("--consumption-receipt", required=True, type=Path)

    shadow = commands.add_parser("shadow", help="run configured source/candidate read comparisons")
    shadow.add_argument("--source-authority-receipt", required=True, type=Path)
    shadow.add_argument("--output", required=True, type=Path)

    reconcile = commands.add_parser("reconcile", help="read and reconcile one explicit journal")
    reconcile.add_argument("--target", required=True, choices=("source", "candidate"))
    reconcile.add_argument("--journal", required=True, type=Path)
    reconcile.add_argument("--output", required=True, type=Path)

    replay = commands.add_parser(
        "replay", help="plan exact source replay; mutation requires the explicit --apply switch"
    )
    replay.add_argument("--journal", required=True, type=Path)
    replay.add_argument("--apply", action="store_true", dest="apply_replay")
    replay.add_argument("--evidence", type=Path)
    replay.add_argument("--approval-receipt", type=Path)
    replay.add_argument("--consumption-receipt", type=Path)
    replay.add_argument("--replay-journal", type=Path)
    replay.add_argument("--output", type=Path)
    return parser


def _require_replay_apply_paths(args: argparse.Namespace) -> tuple[Path, Path, Path, Path, Path]:
    fields = {
        "evidence": args.evidence,
        "approval-receipt": args.approval_receipt,
        "consumption-receipt": args.consumption_receipt,
        "replay-journal": args.replay_journal,
        "output": args.output,
    }
    missing = sorted(name for name, value in fields.items() if value is None)
    if missing:
        raise ValidationError(f"replay --apply requires explicit paths: {missing}")
    return (
        args.evidence,
        args.approval_receipt,
        args.consumption_receipt,
        args.replay_journal,
        args.output,
    )


def _run_replay(args: argparse.Namespace, config: CutoverConfig) -> int:
    source_path = require_absolute_path(str(args.journal), "journal")
    source_journal = AcceptedWriteJournal(source_path)
    if not args.apply_replay:
        _print(_replay_plan(source_journal))
        return 0
    evidence_path, approval_path, consumption_path, replay_path, output = (
        _require_replay_apply_paths(args)
    )
    state = load_cutover_state(config)
    if not state.fault_gate_passed:
        raise ValidationError("replay apply requires a qualified passed fault gate")
    bundle = load_evidence_bundle(evidence_path, config, "replay")
    validate_transition_bundle(
        bundle,
        config,
        accepted_write_count=accepted_write_count(source_journal),
    )
    consume_one_time_approval(
        approval_path,
        consumption_path,
        config,
        action="replay",
        evidence_sha256=bundle.sha256,
    )
    replay_journal_path = require_absolute_path(
        str(replay_path), "replay_journal", must_exist=False
    )
    if replay_journal_path == source_journal.path:
        raise ValidationError("source and replay journals must be distinct")
    receipt = replay_accepted_writes(
        source_journal,
        AcceptedWriteJournal(replay_journal_path),
        _adapter(config, "source"),
        output,
        fault_gate_passed=True,
    )
    _print(receipt)
    return 0 if receipt["exact"] else 1


def main(argv: Sequence[str] | None = None) -> int:
    """Run the explicit-path CLI; no command contacts both services implicitly."""

    args = _parser().parse_args(argv)
    try:
        config = load_cutover_config(args.config)
        if args.command == "plan":
            _print(_plan(config))
            return 0
        if args.command == "status":
            _print(cutover_status(config))
            return 0
        if args.command == "dry-run":
            _print(CanaryCutoverController(config).dry_run(args.transition, args.evidence))
            return 0
        if args.command == "apply":
            state = CanaryCutoverController(config).apply(
                args.transition,
                args.evidence,
                args.approval_receipt,
                args.consumption_receipt,
            )
            _print(state.as_dict())
            return 0
        if args.command == "shadow":
            receipt = run_shadow_comparison(
                config,
                args.source_authority_receipt,
                args.output,
            )
            _print(receipt)
            return 0 if receipt["passed"] else 1
        if args.command == "reconcile":
            journal_path = require_absolute_path(str(args.journal), "journal")
            receipt = reconcile_accepted_writes(
                AcceptedWriteJournal(journal_path),
                _adapter(config, args.target),
                args.output,
            )
            _print(receipt)
            return 0 if receipt["exact"] else 1
        if args.command == "replay":
            return _run_replay(args, config)
        raise ValidationError(f"unknown command: {args.command}")
    except (AdminClientError, OSError, ValidationError, RuntimeError) as exc:
        print(f"cutover command refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
