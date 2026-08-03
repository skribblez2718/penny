"""Auto-recovery — resume interrupted runs from the durable checkpointer.

The "self" in self-recovery: on skill/Penny start, scan for runs left
``running`` or ``awaiting_user`` and re-issue their pending step (or re-present
the pending escalation) by ``run_id`` — no manual resume tool. Durable SQLite
means this survives reboots. Primitives must be safe to re-run (ACT is the one to
guard). See pack 06-technical-reference.md §14.
"""

from __future__ import annotations

from typing import Any

from .checkpointer import STATUS_AWAITING_USER, STATUS_ERROR, Checkpointer
from .playbooks import get_playbook


def recover_pending(  # noqa: C901 - legacy/P0 recovery compatibility
    checkpointer: Checkpointer,
    obs: Any = None,
    session_id: str | None = None,
    playbook: str | None = None,
    include_errored: bool = False,
) -> list[dict]:
    """Return a directive for each resumable run (running/awaiting_user).

    Each directive re-issues the pending step (for ``running``) or re-presents
    the escalation question (for ``awaiting_user``). Unknown playbooks and
    un-rehydratable states are skipped rather than raising.

    When ``playbook`` is given, only runs of THAT playbook are considered. This
    is essential when several engine skills share a ``session_id`` (ad-hoc /
    Door-2 composition): recovering ``frame`` must never resume a pending
    ``observe`` run in the same session.

    ``include_errored`` (F2): when True, ``error`` runs are ALSO surfaced and
    re-driven from the phase they failed on (``ctx.extras['failed_state']``),
    so a hard phase crash is retriable instead of forcing a full restart. This
    is OPT-IN — the default (False) leaves the automatic recovery scan
    unchanged, so genuinely-abandoned error runs are never auto-retried.
    """
    directives: list[dict] = []
    for rec in checkpointer.list_pending(session_id, include_errored=include_errored):
        if playbook is not None and rec.playbook != playbook:
            continue
        pb_cls = get_playbook(rec.playbook)
        if pb_cls is None:
            continue
        pb = pb_cls(checkpointer, obs)
        pb.ctx = rec.context
        pb.sm = pb.machine_cls()
        # For an errored run, the failed phase — not the terminal "error" state —
        # is the resume point. Skip error runs with no recoverable phase.
        resume_state = rec.current_state_id
        if rec.status == STATUS_ERROR:
            resume_state = str((rec.context.extras or {}).get("failed_state") or "")
            if not resume_state:
                continue
        try:
            pb.sm.current_state_value = resume_state
        except Exception:
            continue
        try:
            migrated = pb.prepare_recovery(pb.ctx)
        except Exception:
            continue
        if migrated:
            checkpointer.save(
                run_id=pb.ctx.run_id,
                session_id=pb.ctx.session_id,
                playbook=pb.NAME,
                current_state_id=rec.current_state_id,
                context=pb.ctx,
                status=rec.status,
            )
        if rec.status == STATUS_ERROR:
            # Explicit retry: re-drive the failed phase (tools are idempotent;
            # agent phases re-dispatch). Clear the terminal error markers.
            pb.ctx.errors = []
            pb.ctx.complete = False
            pb.ctx.met = False
            directives.append(pb._advance_to(resume_state))
        elif rec.status == STATUS_AWAITING_USER:
            # Re-present the pending pause — a planned gate re-emits its gate
            # questions; an UNCERTAIN escalation re-emits its clarification.
            directives.append(pb.pending_user_directive(resume_state))
        elif rec.current_state_id in pb.TOOL_STATES:
            # A run interrupted mid tool-state has no agent directive to re-issue;
            # resuming IS re-running the deterministic tool. _advance_to re-drives
            # the tool loop (tool ops are idempotent) and returns the next real
            # directive (agent/gate) once it reaches a dispatchable state.
            directives.append(pb._advance_to(rec.current_state_id))
        else:  # running -> re-issue the pending step (re-run the current agent).
            # Use the PURE directive builder: this scan must be side-effect-free
            # (no checkpoint writes, no duplicate step_start). The step_start for
            # this state was already emitted + persisted when it was first
            # advanced-to, before the interruption; the resumed agent's result
            # then produces the step_end, keeping the obs seq monotonic.
            directives.append(pb._directive_for_state(rec.current_state_id))
    return directives
