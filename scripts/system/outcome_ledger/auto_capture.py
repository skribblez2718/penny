#!/usr/bin/env python3
"""Judge-backed auto-capture — fill the ledger from real work, automatically.

`make rate` needs a human. This closes the other half: a cron job that runs the
CALIBRATED judge (the same model wired into the VERIFY agent vera — MiniMax-M3,
93% agreement with Oracle, 12% false-pass) over recent UNRATED tasks and records
an outcome for each. Goal = a session's opening request; work product = the
assistant's answer to THAT request (the opening exchange, not a later task in the
same session); label = the judge's PASS/FAIL against a task-success rubric, with
its one-line WHY as the ``reason`` the compression loop clusters on.

Why judge-in-cron rather than a hot-path hook in the subagent extension:
observability's ``agent_end`` events carry no verdict or agent identity, and a
TypeScript hook on every subagent completion is hot-path risk for little signal
(most subagents don't emit a PASS/FAIL). Judging completed tasks off the hot
path, capped and best-effort, is safer and produces trustworthy labels for the
work Penny actually does.

    make auto-capture                 # judge + record recent unrated tasks
    ... --dry-run                     # show what would be judged, no calls
    ... --max 5 --model ollama/minimax-m3:cloud

Dedup shares the (session_id, goal) decision-id with `make rate`, so a task is
never both auto-judged and human-rated. The judge's false-pass rate is tracked
by the `judgment` eval section, so the quality of these labels is itself
measured — auto-capture is only as trustworthy as that metric says it is.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import List, Optional, Tuple

_HERE = Path(__file__).resolve().parent
_EVALS = _HERE.parent / "evals"
_JUDGMENT = _HERE.parent / "judgment"
for _p in (_HERE, _EVALS, _JUDGMENT):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from capture import (  # noqa: E402
    FAILURE_MODES,
    existing_decision_ids,
    normalize_failure_mode,
    record_work_outcome,
)
from rate_recent import open_obs, pending_sessions, recent_session_goals  # noqa: E402
from run_judge_agreement import parse_verdict  # noqa: E402
from run_prompt_efficacy import (  # noqa: E402
    contaminating_global_prompts,
    parse_assistant_stream,
    parse_model_spec,
    probe_provider,
)

DEFAULT_JUDGE = "ollama/minimax-m3:cloud"  # keep in sync with .pi/agents/vera.md

_FAILURE_MODE_LIST = " | ".join(FAILURE_MODES)

JUDGE_SYSTEM = f"""You judge whether an assistant's response accomplished the user's stated GOAL.

PASS = the response substantively achieved the goal with a usable result.
FAIL = it failed, refused wrongly, produced a wrong/unusable/incomplete result, or left the goal unmet.

Judge the OUTCOME, not the effort, length, or tone. If the response only partially achieved the goal, FAIL and name what is missing. When the goal is a question, PASS only if it was actually answered correctly.

Output EXACTLY three lines and nothing else:
VERDICT: PASS
WHY: <one sentence — for FAIL, the KIND of thing that went wrong (a groupable failure signature)>
FAILURE_MODE: <for FAIL, a short snake_case tag for the KIND of failure. Prefer one of: {_FAILURE_MODE_LIST}; if none fits, coin a specific 2-4 word snake_case tag. For PASS, write: none>

Prefer an existing category when it fits; only coin a new tag for a genuinely distinct failure kind (not a reworded synonym).
"""

_WHY_RE = re.compile(r"^\s*why\s*[:\-]\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
_FAILURE_MODE_RE = re.compile(r"^\s*failure_mode\s*[:\-]\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
_DELTA = {"PASS": "MATCH", "FAIL": "MISMATCH"}


def opening_response(con, session_id: str) -> str:
    """The assistant's answer to the session's OPENING goal — the last substantive
    assistant message BEFORE the second user turn.

    Pairing the first user request with the session's *last* assistant message
    mislabels multi-task sessions: the final message answers a later, different
    task, so the judge (correctly) calls it off-topic. Scoping to the opening
    exchange keeps goal↔response aligned and naturally judges only the first task
    of a multi-task session (the rest are left for `make rate`).
    """
    rows = con.execute(
        "SELECT role, data FROM entries WHERE session_id = ? ORDER BY timestamp, id",
        (session_id,),
    ).fetchall()
    started = False
    answer = ""
    for role, data in rows:
        if role == "user":
            if started:
                break  # second user turn → end of the opening exchange
            started = True
            continue
        if started and role == "assistant":
            text, stop = _assistant_msg(data)
            # Only a COMPLETED final answer counts. Skip toolUse narration
            # ("Let me check…"), aborted/error partials, and clarifying-question
            # turns — judging those yields a false FAIL and permanently blocks
            # `make rate` (shared dedup id). "" = an entry with no stopReason
            # field (older/other-shaped entries); accept it rather than lose data.
            if text.strip() and stop in ("stop", ""):
                answer = text
    return answer


def _assistant_msg(data: str) -> Tuple[str, str]:
    """(concatenated text, stopReason) for an assistant entry blob."""
    try:
        obj = json.loads(data)
    except (json.JSONDecodeError, TypeError):
        return "", ""
    text = "".join(
        b.get("text", "")
        for b in obj.get("content", [])
        if isinstance(b, dict) and b.get("type") == "text"
    )
    return text, str(obj.get("stopReason", ""))


def parse_reason(text: str) -> str:
    # Last, line-anchored WHY — matching parse_verdict's last-match rule, so a
    # chatty judge that writes "why" mid-sentence before its real WHY line does
    # not poison the reason the compression loop clusters on.
    matches = _WHY_RE.findall(text)
    return matches[-1].strip()[:200] if matches else ""


def parse_failure_mode(text: str) -> str:
    # Last, line-anchored FAILURE_MODE, normalized to the controlled vocab.
    # Empty (or "none") for a PASS or an unparseable line.
    matches = _FAILURE_MODE_RE.findall(text)
    return normalize_failure_mode(matches[-1]) if matches else ""


def recent_unrated_tasks(con, existing_ids: set, limit: int) -> List[Tuple[str, str, str]]:
    """(session_id, goal, response) for recent sessions with no outcome yet and a
    non-empty final assistant response."""
    goals = recent_session_goals(con, limit)
    tasks: List[Tuple[str, str, str]] = []
    for session_id, goal, _ in pending_sessions(goals, existing_ids):
        response = opening_response(con, session_id)
        if response.strip():
            tasks.append((session_id, goal, response))
    return tasks


def judge_task(
    goal: str,
    response: str,
    provider: str,
    model: str,
    system_prompt_path: Path,
    workdir: Path,
    timeout_s: int,
) -> Optional[Tuple[str, str, str]]:
    """Run the calibrated judge on (goal, response). Returns
    (delta_score, reason, failure_mode) or None on any failure — auto-capture
    must never raise. failure_mode is "" for a PASS."""
    clipped = response[:6000]
    if len(response) > 6000:
        # Mark the cut so the rubric doesn't FAIL a long correct answer merely
        # for appearing unfinished.
        clipped += (
            "\n[response truncated for length — judge completeness on what is shown, not the cut]"
        )
    user = f"GOAL\n{goal}\n\nRESPONSE\n{clipped}\n"
    cmd = [
        "pi",
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-tools",
        "--provider",
        provider,
        "--model",
        model,
        "--thinking",
        "low",
        "--system-prompt",
        str(system_prompt_path),
        user,
    ]
    env = dict(os.environ)
    env["PI_SKIP_VERSION_CHECK"] = "1"
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(workdir),
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            errors="replace",  # a stray non-UTF8 byte must not raise UnicodeDecodeError
            timeout=timeout_s,
        )
    except Exception:  # noqa: BLE001 — best-effort: any spawn/decode error skips this task
        return None
    last = parse_assistant_stream(proc.stdout, {"tokens_in": 0, "tokens_out": 0})
    if last is None or str(last.get("stopReason", "")) in ("error", "aborted"):
        return None
    text = "".join(
        b.get("text", "")
        for b in last.get("content", [])
        if isinstance(b, dict) and b.get("type") == "text"
    )
    verdict = parse_verdict(text)
    if verdict not in _DELTA:
        return None
    delta = _DELTA[verdict]
    # Only a MISMATCH carries a failure_mode (the clustering key); a MATCH leaves
    # it empty so it never enters the compression loop.
    failure_mode = parse_failure_mode(text) if delta == "MISMATCH" else ""
    return delta, parse_reason(text), failure_mode


def run(limit: int, max_judge: int, model_spec: str, dry_run: bool) -> dict:
    con = open_obs()
    if con is None:
        return {"judged": 0, "recorded": 0, "error": "no observability db"}
    try:
        existing = existing_decision_ids()
    except Exception:  # noqa: BLE001
        # Fail CLOSED: without the dedup set, record_work_outcome would re-record
        # already-captured sessions (its timestamp makes each write content-unique,
        # so the store's own dedup won't catch them), double-counting in the
        # compression loop. Skip this run instead; the next one recovers.
        return {"judged": 0, "recorded": 0, "error": "could not read existing outcomes; skipped"}
    tasks = recent_unrated_tasks(con, existing, limit)[:max_judge]
    if dry_run:
        return {"would_judge": len(tasks), "tasks": [g[:70] for _, g, _ in tasks]}
    if not tasks:
        return {"judged": 0, "recorded": 0}

    provider, model = parse_model_spec(model_spec)
    skip = probe_provider(provider)
    if skip:
        return {"judged": 0, "recorded": 0, "error": skip}
    if contaminating_global_prompts():
        return {"judged": 0, "recorded": 0, "error": "global prompt would confound the judge"}

    staging = Path(tempfile.mkdtemp(prefix="penny-autocap-"))
    try:
        judged, recorded = _judge_and_record(tasks, provider, model, staging, existing)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return {"judged": judged, "recorded": recorded, "model": model}


def _judge_and_record(
    tasks: List[Tuple[str, str, str]],
    provider: str,
    model: str,
    staging: Path,
    existing: set,
) -> Tuple[int, int]:
    workdir = staging / "cwd"
    workdir.mkdir()
    sys_prompt = staging / "judge.md"
    sys_prompt.write_text(JUDGE_SYSTEM, encoding="utf-8")
    judged = recorded = 0
    for session_id, goal, response in tasks:
        verdict = judge_task(goal, response, provider, model, sys_prompt, workdir, 300)
        if verdict is None:
            continue
        judged += 1
        delta, reason, failure_mode = verdict
        did = record_work_outcome(
            goal=goal,
            action_taken=response[:400],
            delta_score=delta,
            reason=reason,
            failure_mode=failure_mode,
            session_id=session_id,
            source="judge_auto",
            existing_ids=existing,
        )
        if did:
            recorded += 1
    return judged, recorded


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=25, help="recent sessions to consider")
    parser.add_argument("--max", type=int, default=15, help="max tasks to judge per run (cost cap)")
    parser.add_argument("--model", default=DEFAULT_JUDGE, help="provider/model judge spec")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = run(args.limit, args.max, args.model, args.dry_run)
    if args.json or args.dry_run:
        print(json.dumps(result))
    else:
        print(
            f"auto-capture: judged {result.get('judged', 0)}, "
            f"recorded {result.get('recorded', 0)} outcome(s)"
            + (f" — {result['error']}" if result.get("error") else "")
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
