"""CLI — ``orchestrate {start|step|status}``, the entry point skills delegate to.

Prints exactly one JSON directive to stdout. State is loaded from the durable
checkpointer by ``--run-id`` — there is deliberately no state-on-argv flag. See
pack 06-technical-reference.md §11.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

from .checkpointer import Checkpointer
from .contracts import Directives
from .obs_client import ObsClient
from .playbooks import get_playbook


def _max_step_retries_from_env(default: int = 2) -> int:
    """Transient step-retry budget, from ``PENNY_ORCH_MAX_STEP_RETRIES`` (§15).
    A malformed/failed step is re-issued up to this many times before the engine
    routes to error. Non-int or negative values fall back to the default."""
    raw = os.environ.get("PENNY_ORCH_MAX_STEP_RETRIES")
    if raw is None:
        return default
    try:
        val = int(raw)
    except (TypeError, ValueError):
        return default
    return val if val >= 0 else default


def _add_common(p: argparse.ArgumentParser, default_playbook: str | None) -> None:
    p.add_argument("--playbook", default=default_playbook)
    p.add_argument("--session-id", required=True)
    p.add_argument("--run-id", required=True)
    p.add_argument("--project-root", default="")


def build_parser(default_playbook: str | None = None) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="orchestrate")
    sub = parser.add_subparsers(dest="command", required=True)

    p_start = sub.add_parser("start")
    _add_common(p_start, default_playbook)
    p_start.add_argument("--goal", default="")
    p_start.add_argument("--constraints", default="")

    p_step = sub.add_parser("step")
    _add_common(p_step, default_playbook)
    p_step.add_argument("--agent", default="")
    p_step.add_argument("--result", default="")

    p_status = sub.add_parser("status")
    _add_common(p_status, default_playbook)

    # recover: auto-resume any pending run for the session (re-issue the pending
    # step, or re-present the escalation). Powers the driver's kill-and-resume.
    p_recover = sub.add_parser("recover")
    _add_common(p_recover, default_playbook)

    return parser


def _emit(directive: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(directive) + "\n")


def main(default_playbook: str | None = None, argv: list[str] | None = None) -> int:  # noqa: C901
    parser = build_parser(default_playbook)
    args = parser.parse_args(argv)

    session_id: str = args.session_id
    run_id: str = args.run_id
    playbook_name = args.playbook or default_playbook

    pb_cls = get_playbook(playbook_name) if playbook_name else None
    if pb_cls is None:
        _emit(
            Directives.error(
                errors=[f"unknown playbook '{playbook_name}'"], session_id=session_id, run_id=run_id
            )
        )
        return 1

    checkpointer = Checkpointer(project_root=args.project_root or None)
    obs = ObsClient()
    pb = pb_cls(checkpointer, obs, max_step_retries=_max_step_retries_from_env())

    if args.command == "start":
        # Opportunistic retention: prune terminal runs older than the window so
        # the checkpointer DB does not grow unbounded. Best-effort — never blocks
        # or fails a fresh run.
        try:
            checkpointer.purge_older_than()
        except Exception:
            pass
        constraints: dict[str, Any] = {}
        if args.constraints:
            try:
                constraints = json.loads(args.constraints)
            except (json.JSONDecodeError, ValueError) as exc:
                _emit(
                    Directives.error(
                        errors=[f"invalid --constraints JSON: {exc}"],
                        session_id=session_id,
                        run_id=run_id,
                    )
                )
                return 1
        directive = pb.start(
            session_id=session_id,
            run_id=run_id,
            goal=args.goal,
            constraints=constraints,
            project_root=args.project_root,
        )
    elif args.command == "step":
        result: Any = {}
        if args.result:
            try:
                result = json.loads(args.result)
            except (json.JSONDecodeError, ValueError) as exc:
                _emit(
                    Directives.error(
                        errors=[f"invalid --result JSON: {exc}"],
                        session_id=session_id,
                        run_id=run_id,
                    )
                )
                return 1
        directive = pb.step(session_id=session_id, run_id=run_id, agent=args.agent, result=result)
    elif args.command == "recover":
        from .recovery import recover_pending

        # Scope recovery to THIS skill's playbook so a shared session_id across
        # engine skills (ad-hoc composition) never resumes the wrong run.
        directives = recover_pending(
            checkpointer, obs, session_id=session_id, playbook=playbook_name
        )
        directive = (
            directives[0]
            if directives
            else Directives.status(
                state="unknown", complete=False, session_id=session_id, run_id=run_id
            )
        )
    else:  # status
        directive = pb.status(session_id=session_id, run_id=run_id)

    _emit(directive)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
