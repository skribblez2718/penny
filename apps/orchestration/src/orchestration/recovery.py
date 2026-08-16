"""Exact and scan-based recovery from the durable Python checkpointer.

``recover_run`` addresses one immutable run identity. ``recover_pending`` is the
separate operational scan used to list/reissue all resumable records. Neither
operation guesses a row by session/playbook ordering.
"""

from __future__ import annotations

from typing import Any

from .checkpointer import (
    STATUS_AWAITING_USER,
    STATUS_COMPLETE,
    STATUS_ERROR,
    STATUS_INCOMPLETE,
    STATUS_RUNNING,
    CheckpointRecord,
    Checkpointer,
)
from .contracts import Directives, artifact_dispatch_control
from .playbooks import get_playbook

_TERMINAL_STATUSES = frozenset({STATUS_COMPLETE, STATUS_INCOMPLETE, STATUS_ERROR})


def _unavailable_playbook(rec: CheckpointRecord) -> dict[str, Any]:
    """Return an actionable tombstone without altering the legacy checkpoint."""
    return {
        "schema_version": 2,
        "action": "error",
        "code": "PLAYBOOK_UNAVAILABLE",
        "retryable": False,
        "errors": [
            f"playbook '{rec.playbook}' is not available in this runtime; "
            "the legacy checkpoint remains unchanged"
        ],
        "playbook": rec.playbook,
        "status": rec.status,
        "session_id": rec.session_id,
        "run_id": rec.run_id,
    }


def _recover_record(  # noqa: C901 - recovery status and state branches
    checkpointer: Checkpointer,
    rec: CheckpointRecord,
    obs: Any,
    *,
    retry_errored: bool,
) -> dict[str, Any]:
    pb_cls = get_playbook(rec.playbook)
    if pb_cls is None:
        return _unavailable_playbook(rec)

    if rec.status in {STATUS_COMPLETE, STATUS_INCOMPLETE} or (
        rec.status == STATUS_ERROR and not retry_errored
    ):
        return Directives.status(
            state=rec.current_state_id,
            complete=True,
            session_id=rec.session_id,
            run_id=rec.run_id,
        )

    resume_state = rec.current_state_id
    if rec.status == STATUS_ERROR:
        resume_state = str((rec.context.extras or {}).get("failed_state") or "")
        if not resume_state:
            return Directives.error(
                errors=[
                    "errored run has no recoverable failed_state; start a new run "
                    "or retain the checkpoint for inspection"
                ],
                session_id=rec.session_id,
                run_id=rec.run_id,
            )

    dispatch_control = artifact_dispatch_control()
    if not dispatch_control.dispatch_allowed:
        return Directives.paused(
            state_id=resume_state,
            run_status=rec.status,
            session_id=rec.session_id,
            run_id=rec.run_id,
            control=dispatch_control,
        )

    pb = pb_cls(checkpointer, obs)
    pb.ctx = rec.context
    pb.sm = pb.machine_cls()
    try:
        pb.sm.current_state_value = resume_state
    except Exception as exc:
        return Directives.error(
            errors=[f"cannot rehydrate state '{resume_state}': {exc}"],
            session_id=rec.session_id,
            run_id=rec.run_id,
        )

    try:
        migrated = pb.prepare_recovery(pb.ctx)
    except Exception as exc:
        return Directives.error(
            errors=[f"recovery checkpoint validation failed: {exc}"],
            session_id=rec.session_id,
            run_id=rec.run_id,
        )
    if migrated:
        checkpointer.save(
            run_id=rec.run_id,
            session_id=rec.session_id,
            playbook=rec.playbook,
            current_state_id=rec.current_state_id,
            context=pb.ctx,
            status=rec.status,
        )

    if rec.status == STATUS_ERROR:
        pb.ctx.errors = []
        pb.ctx.complete = False
        pb.ctx.met = False
        return pb._advance_to(resume_state)
    if rec.status == STATUS_AWAITING_USER:
        return pb.pending_user_directive(resume_state)
    if rec.status != STATUS_RUNNING:
        return Directives.error(
            errors=[f"unsupported checkpoint status '{rec.status}'"],
            session_id=rec.session_id,
            run_id=rec.run_id,
        )
    if rec.current_state_id in pb.TOOL_STATES:
        return pb._advance_to(rec.current_state_id)
    return pb._directive_for_state(rec.current_state_id)


def recover_run(
    checkpointer: Checkpointer,
    *,
    run_id: str,
    obs: Any = None,
    session_id: str | None = None,
    playbook: str | None = None,
    retry_errored: bool = False,
) -> dict[str, Any]:
    """Recover exactly ``run_id`` and fail closed on identity mismatch."""
    rec = checkpointer.load(run_id)
    if rec is None:
        return Directives.status(
            state="unknown",
            complete=False,
            session_id=session_id or "",
            run_id=run_id,
        )
    if session_id is not None and rec.session_id != session_id:
        return Directives.error(
            errors=["requested session_id does not match the run's immutable identity"],
            session_id=session_id,
            run_id=run_id,
        )
    if playbook is not None and rec.playbook != playbook:
        return Directives.error(
            errors=["requested playbook does not match the run's immutable identity"],
            session_id=session_id or rec.session_id,
            run_id=run_id,
        )
    return _recover_record(checkpointer, rec, obs, retry_errored=retry_errored)


def recover_pending(  # noqa: C901 - public scan compatibility surface
    checkpointer: Checkpointer,
    obs: Any = None,
    session_id: str | None = None,
    playbook: str | None = None,
    include_errored: bool = False,
) -> list[dict[str, Any]]:
    """Scan pending records explicitly; unknown playbooks surface tombstones."""
    directives: list[dict[str, Any]] = []
    for rec in checkpointer.list_pending(session_id, include_errored=include_errored):
        if playbook is not None and rec.playbook != playbook:
            continue
        directives.append(_recover_record(checkpointer, rec, obs, retry_errored=include_errored))
    return directives
