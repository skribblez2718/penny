#!/usr/bin/env python3
"""Behavioral-regression runner — replay Oracle-era fixtures; block drift below them.

The eval ratchet catches *metric* regression. This catches *behavioral*
regression: the system silently producing worse outputs than Oracle did. Each
fixture (fixtures.json, Oracle-authored) is replayed through the CURRENT system
(production frame + driver model), and the calibrated judge scores the replay
against the fixture's ``pass_bar`` + ``load_bearing_facts`` — quality, not
byte-identity (open models phrase differently).

    make trajectory                 # replay all fixtures, judge, write artifact
    ... --dry-run                    # list fixtures, no calls
    ... --driver-model ollama/glm-5.2:cloud --judge-model ollama/minimax-m3:cloud

Two-part split like prompt-efficacy: this EXPENSIVE runner writes
``.penny/evals/trajectory/latest.json``; the cheap ``eval_trajectory`` section
ratchets it in every ``make evals``. A fixture Oracle passed that the current
system fails is a behavioral regression — it rides the signal pipeline into the
session brief. Run weekly / before adopting an amendment, not per-eval.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

_HERE = Path(__file__).resolve().parent
_EVALS = _HERE.parent / "evals"
_JUDGMENT = _HERE.parent / "judgment"
for _p in (_EVALS, _JUDGMENT):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from run_judge_agreement import parse_verdict  # noqa: E402
from run_prompt_efficacy import (  # noqa: E402
    contaminating_global_prompts,
    parse_assistant_stream,
    parse_model_spec,
    probe_provider,
)

REPO_ROOT = _HERE.parents[2]
FIXTURES_PATH = _HERE / "fixtures.json"
FRAME_PATH = REPO_ROOT / ".pi" / "SYSTEM.md"
RESULTS_DIR = REPO_ROOT / ".penny" / "evals" / "trajectory"
LATEST_PATH = RESULTS_DIR / "latest.json"

DEFAULT_DRIVER = "ollama/glm-5.2:cloud"  # the production orchestration driver
DEFAULT_JUDGE = "ollama/minimax-m3:cloud"  # the calibrated verifier (= vera)

_JUDGE_SYSTEM = """You judge whether a REPLAY of a task still meets a fixed quality bar.

You are given the ORIGINAL TASK, a PASS BAR (what a non-regressed answer must still do), the LOAD-BEARING FACTS it must preserve, and the REPLAY (the current system's answer). Judge the replay against the PASS BAR — on quality and preservation of the load-bearing facts, NOT on wording or whether it matches any reference phrasing.

Output EXACTLY two lines and nothing else:
VERDICT: PASS
WHY: <one sentence — for FAIL, which part of the pass bar or which load-bearing fact was missed>
"""


def load_fixtures() -> List[Dict[str, Any]]:
    return json.loads(FIXTURES_PATH.read_text(encoding="utf-8")).get("fixtures", [])


def _pi_text(
    provider: str,
    model: str,
    system_prompt: Optional[Path],
    user: str,
    workdir: Path,
    timeout_s: int,
) -> Optional[Tuple[str, str]]:
    """One headless pi call → (text, stopReason), or None on any failure."""
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
    ]
    if system_prompt is not None:
        cmd += ["--system-prompt", str(system_prompt)]
    cmd.append(user)
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
            errors="replace",
            timeout=timeout_s,
        )
    except Exception:  # noqa: BLE001 — best-effort
        return None
    last = parse_assistant_stream(proc.stdout, {"tokens_in": 0, "tokens_out": 0})
    if last is None:
        return None
    text = "".join(
        b.get("text", "")
        for b in last.get("content", [])
        if isinstance(b, dict) and b.get("type") == "text"
    )
    return text, str(last.get("stopReason", ""))


def replay(
    fixture: Dict[str, Any], provider: str, model: str, frame: Path, workdir: Path, timeout_s: int
) -> Optional[str]:
    """Replay the fixture's task through the current system (production frame)."""
    result = _pi_text(provider, model, frame, fixture["task"], workdir, timeout_s)
    if result is None or result[1] in ("error", "aborted"):
        return None
    return result[0]


def judge_replay(
    fixture: Dict[str, Any],
    response: str,
    provider: str,
    model: str,
    sys_prompt: Path,
    workdir: Path,
    timeout_s: int,
) -> Optional[Tuple[str, str]]:
    facts = "\n".join(f"- {f}" for f in fixture.get("load_bearing_facts", []))
    user = (
        f"ORIGINAL TASK\n{fixture['task']}\n\n"
        f"PASS BAR\n{fixture['pass_bar']}\n\n"
        f"LOAD-BEARING FACTS\n{facts}\n\n"
        f"REPLAY\n{response[:6000]}\n"
    )
    result = _pi_text(provider, model, sys_prompt, user, workdir, timeout_s)
    if result is None or result[1] in ("error", "aborted"):
        return None
    verdict = parse_verdict(result[0])
    if verdict not in ("PASS", "FAIL"):
        return None
    why = ""
    import re

    m = re.search(r"(?im)^\s*why\s*[:\-]\s*(.+?)\s*$", result[0])
    if m:
        why = m.group(1).strip()[:200]
    return verdict, why


_ROUTE_WRAPPER = (
    "First, state ONLY your routing decision for the task below — do NOT answer "
    "it. Per your Route to the Right Abstraction guidance, output EXACTLY one "
    "line:\nROUTE: direct   (or: ROUTE: skill:<name>  /  ROUTE: agent:<name>)\n\n"
    "TASK:\n{task}\n"
)


def parse_route(text: str) -> Optional[str]:
    """Normalize the system's routing decision to 'direct' | 'skill:<x>' |
    'agent:<x>' from a 'ROUTE: ...' line (last match wins)."""
    import re

    matches = re.findall(r"(?im)^\s*route\s*[:\-]\s*(.+?)\s*$", text)
    if not matches:
        return None
    raw = matches[-1].strip().lower()
    if raw.startswith("direct"):
        return "direct"
    m = re.match(r"(skill|agent)\s*[:/]?\s*([a-z0-9_-]+)", raw)
    if m:
        return f"{m.group(1)}:{m.group(2)}"
    return raw.split()[0] if raw else None


def capture_route(fixture, provider, model, frame, workdir, timeout_s) -> Optional[str]:
    """Ask the current system (under the production frame) how it would ROUTE the
    task — the delegation decision, not the answer. Best-effort → None on failure."""
    result = _pi_text(
        provider, model, frame, _ROUTE_WRAPPER.format(task=fixture["task"]), workdir, timeout_s
    )
    if result is None or result[1] in ("error", "aborted"):
        return None
    return parse_route(result[0])


def run_fixture(fixture, driver, judge, frame, sys_prompt, workdir, timeout_s):
    dp, dm = driver
    jp, jm = judge
    cell = {
        "id": fixture["id"],
        "workflow": fixture.get("workflow", ""),
        "verdict": None,
        "why": "",
        "error": None,
        "expected_route": fixture.get("expected_route", ""),
        "route": None,
        "route_ok": None,
    }
    response = replay(fixture, dp, dm, frame, workdir, timeout_s)
    if not response:
        cell["error"] = "replay produced no output"
        return cell
    cell["replay_sha256"] = hashlib.sha256(response.encode("utf-8")).hexdigest()
    judged = judge_replay(fixture, response, jp, jm, sys_prompt, workdir, timeout_s)
    if judged is None:
        cell["error"] = "judge produced no verdict"
        return cell
    cell["verdict"], cell["why"] = judged
    # Route-fidelity (informational): did the system still make the right
    # delegation call? Captured only when the fixture declares an expected_route.
    if fixture.get("expected_route"):
        route = capture_route(fixture, dp, dm, frame, workdir, timeout_s)
        cell["route"] = route
        if route is not None:
            cell["route_ok"] = route == fixture["expected_route"]
    return cell


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--driver-model", default=DEFAULT_DRIVER)
    parser.add_argument("--judge-model", default=DEFAULT_JUDGE)
    parser.add_argument("--fixtures", default="", help="comma list of fixture ids")
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--dry-run", action="store_true")
    return parser


def _select_fixtures(fixtures_arg: str) -> List[Dict[str, Any]]:
    fixtures = load_fixtures()
    if fixtures_arg:
        wanted = {f.strip() for f in fixtures_arg.split(",") if f.strip()}
        fixtures = [f for f in fixtures if f["id"] in wanted]
    return fixtures


def _preflight(driver: Tuple[str, str], judge: Tuple[str, str]) -> Optional[str]:
    """Return an error string if the run can't proceed, else None."""
    if shutil.which("pi") is None:
        return "pi CLI not found"
    if not FRAME_PATH.exists():
        return f"frame not found: {FRAME_PATH}"
    if contaminating_global_prompts():
        return "a global prompt file would confound the replay/judge"
    for provider in {driver[0], judge[0]}:
        skip = probe_provider(provider)
        if skip:
            return skip
    return None


def _run_all(fixtures, driver, judge, timeout_s) -> List[Dict[str, Any]]:
    staging = Path(tempfile.mkdtemp(prefix="penny-traj-"))
    workdir = staging / "cwd"
    workdir.mkdir()
    sys_prompt = staging / "judge.md"
    sys_prompt.write_text(_JUDGE_SYSTEM, encoding="utf-8")
    cells: List[Dict[str, Any]] = []
    try:
        for i, fixture in enumerate(fixtures, 1):
            cell = run_fixture(fixture, driver, judge, FRAME_PATH, sys_prompt, workdir, timeout_s)
            cells.append(cell)
            mark = "ERR " if cell["error"] else cell["verdict"]
            print(
                f"[{i}/{len(fixtures)}] {mark:<5} {cell['id']}"
                + (f"  ({cell['why']})" if cell.get("why") else "")
            )
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return cells


def main() -> int:
    args = build_parser().parse_args()
    fixtures = _select_fixtures(args.fixtures)
    if not fixtures:
        print("no fixtures selected")
        return 2
    driver = parse_model_spec(args.driver_model)
    judge = parse_model_spec(args.judge_model)
    print(f"trajectory: {len(fixtures)} fixture(s), driver={driver[1]}, judge={judge[1]}")
    if args.dry_run:
        for f in fixtures:
            print(f"  {f['id']:<28} {f.get('workflow', '')}")
        return 0
    error = _preflight(driver, judge)
    if error:
        print(f"cannot run: {error}")
        return 2

    cells = _run_all(fixtures, driver, judge, args.timeout)

    write_artifact(fixtures, driver, judge, cells)
    scored = [c for c in cells if c["verdict"] in ("PASS", "FAIL")]
    passed = sum(1 for c in scored if c["verdict"] == "PASS")
    print(f"\npass rate: {passed}/{len(scored)} scored ({len(cells) - len(scored)} errored)")
    routed = [c for c in cells if c.get("route_ok") is not None]
    if routed:
        ok = sum(1 for c in routed if c["route_ok"])
        print(f"route fidelity: {ok}/{len(routed)} routed correctly (informational)")
        for c in routed:
            if not c["route_ok"]:
                print(f"  route drift {c['id']}: expected {c['expected_route']}, got {c['route']}")
    regressions = [c["id"] for c in scored if c["verdict"] == "FAIL"]
    if regressions:
        print("BEHAVIORAL REGRESSIONS: " + ", ".join(regressions))
    return 0


def write_artifact(fixtures, driver, judge, cells) -> None:
    stamp = datetime.now(timezone.utc)
    artifact = {
        "ts": stamp.isoformat(),
        "runner_version": 1,
        "driver_model": driver[1],
        "judge_model": judge[1],
        "frame_sha256": hashlib.sha256(FRAME_PATH.read_bytes()).hexdigest(),
        "fixtures_sha256": hashlib.sha256(FIXTURES_PATH.read_bytes()).hexdigest(),
        "fixture_count": len(fixtures),
        "cells": cells,
    }
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    (RESULTS_DIR / f"run-{stamp.strftime('%Y%m%dT%H%M%SZ')}.json").write_text(
        json.dumps(artifact, indent=2) + "\n", encoding="utf-8"
    )
    LATEST_PATH.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    print(f"results → {LATEST_PATH}")


if __name__ == "__main__":
    raise SystemExit(main())
