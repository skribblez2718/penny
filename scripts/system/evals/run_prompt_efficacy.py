#!/usr/bin/env python3
"""Prompt-efficacy matrix runner — the EXPENSIVE half of the prompt_efficacy section.

Replays the curated golden task set (golden_prompt_tasks.json) through headless
pi, per model family, in matched arms:

  on          .pi/SYSTEM.md passed via --system-prompt (the Cognitive Frame)
  off         no --system-prompt (pi's built-in default prompt)
  ablate:<s>  frame with one <system_context> section removed (--ablate only)

Every arm runs from a hermetic temp cwd OUTSIDE the repo with extensions,
skills, context files, sessions, and tools disabled, so the ONLY difference
between arms is the frame text. Results land in
``.penny/evals/prompt_efficacy/latest.json`` where the cheap eval section
(eval_prompt_efficacy.py) ratchets them. This runner is never invoked by
``make evals`` or the ambient cron — run it manually or weekly:

    make evals-prompt-efficacy            # default matrix
    .venv/bin/python scripts/system/evals/run_prompt_efficacy.py --ablate
    ... --models ollama/glm-5.2:cloud --tasks log-triage-crash-source --trials 3

When a family's frame-on pass rate falls below frame-off beyond the noise
margin, a dedicated CRITICAL ``prompt_degradation_<family>_<date>`` signal is
written to penny/signals (7-day expiry) so the next session brief surfaces it —
this is the "reasoning-model degradation monitoring" the Cognitive Frame
standards promise (docs/agents/prompts/cognitive-frame-standards.md).
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval_lib import REPO_ROOT  # noqa: E402
from eval_prompt_efficacy import (  # noqa: E402
    GOLDEN_PATH,
    LATEST_PATH,
    MIN_FAMILY_TASKS,
    RESULTS_DIR,
    degradation_margin,
    family_rates,
    grade_text,
)

FRAME_PATH = REPO_ROOT / ".pi" / "SYSTEM.md"
OLLAMA_PROBE_URL = "http://127.0.0.1:11434/api/version"
PROVIDER_KEY_ENV = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "minimax": "MINIMAX_API_KEY",
    "zai": "ZAI_API_KEY",
    "kimi": "KIMI_API_KEY",
    "groq": "GROQ_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}

FAMILY_PREFIXES = (
    ("glm", "glm"),
    ("deepseek", "deepseek"),
    ("minimax", "minimax"),
    ("kimi", "kimi"),
    ("claude", "claude"),
    ("qwen", "qwen"),
    ("gpt", "openai"),
)


def pi_agent_dir() -> Path:
    """The pi config dir headless runs read (PI_CODING_AGENT_DIR or ~/.pi/agent)."""
    override = os.environ.get("PI_CODING_AGENT_DIR")
    return Path(override) if override else Path.home() / ".pi" / "agent"


def contaminating_global_prompts() -> List[Path]:
    """Global prompt files that would break the frame-on/off contrast if present."""
    agent_dir = pi_agent_dir()
    return [
        agent_dir / name
        for name in ("SYSTEM.md", "APPEND_SYSTEM.md")
        if (agent_dir / name).exists()
    ]


def family_of(model_id: str) -> str:
    lowered = model_id.lower()
    for prefix, family in FAMILY_PREFIXES:
        if lowered.startswith(prefix):
            return family
    return re.split(r"[-:./]", lowered, 1)[0] or "unknown"


def parse_model_spec(spec: str) -> Tuple[str, str]:
    """'provider/model' → (provider, model); bare model defaults to ollama."""
    if "/" in spec:
        provider, model = spec.split("/", 1)
        return provider.strip(), model.strip()
    return "ollama", spec.strip()


# ── Frame sectioning (for --ablate) ─────────────────────────────────────────


def frame_sections(frame_text: str) -> List[Tuple[str, str]]:
    """Split the <system_context> block into (slug, section_text) pairs.

    Sections are the `# `-level headings inside <system_context>; everything
    outside the block (security directives, verification rule) is never ablated.
    """
    match = re.search(r"<system_context>(.*?)</system_context>", frame_text, re.DOTALL)
    if not match:
        return []
    body = match.group(1)
    sections: List[Tuple[str, str]] = []
    current_title: Optional[str] = None
    current_lines: List[str] = []
    for line in body.splitlines(keepends=True):
        heading = re.match(r"^# (.+?)\s*$", line)
        if heading:
            if current_title is not None:
                sections.append((slugify(current_title), "".join(current_lines)))
            current_title = heading.group(1)
            current_lines = [line]
        elif current_title is not None:
            current_lines.append(line)
    if current_title is not None:
        sections.append((slugify(current_title), "".join(current_lines)))
    return sections


def slugify(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")


def ablated_frame(frame_text: str, section_text: str) -> str:
    return frame_text.replace(section_text, "", 1)


# ── One matrix cell ─────────────────────────────────────────────────────────


def run_cell(
    task: Dict[str, Any],
    provider: str,
    model: str,
    arm: str,
    trial: int,
    system_prompt_path: Optional[Path],
    workdir: Path,
    thinking: str,
    timeout_s: int,
) -> Dict[str, Any]:
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
        thinking,
    ]
    if system_prompt_path is not None:
        cmd += ["--system-prompt", str(system_prompt_path)]
    cmd.append(task["prompt"])

    env = dict(os.environ)
    env["PI_SKIP_VERSION_CHECK"] = "1"

    cell: Dict[str, Any] = {
        "task_id": task["id"],
        "category": task.get("category", ""),
        "model": model,
        "provider": provider,
        "family": family_of(model),
        "arm": arm,
        "trial": trial,
        "passed": False,
        "checks": {},
        "error": None,
        "stop_reason": "",
        "tokens_in": 0,
        "tokens_out": 0,
        "latency_s": 0.0,
        "text_sha256": "",
        "text_head": "",
    }
    started = time.monotonic()
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(workdir),
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        cell["error"] = f"timeout after {timeout_s}s"
        cell["latency_s"] = round(time.monotonic() - started, 1)
        return cell
    except OSError as exc:
        cell["error"] = f"spawn failed: {exc}"
        return cell
    cell["latency_s"] = round(time.monotonic() - started, 1)

    last_assistant = parse_assistant_stream(proc.stdout, cell)
    if last_assistant is None:
        stderr_tail = (proc.stderr or "").strip()[-300:]
        cell["error"] = f"no assistant message (exit {proc.returncode}): {stderr_tail}"
        return cell

    cell["stop_reason"] = str(last_assistant.get("stopReason", ""))
    if cell["stop_reason"] in ("error", "aborted"):
        cell["error"] = (
            f"stopReason={cell['stop_reason']}: "
            + str(last_assistant.get("errorMessage", ""))[:300]
        )
        return cell

    text = "".join(
        block.get("text", "")
        for block in last_assistant.get("content", [])
        if isinstance(block, dict) and block.get("type") == "text"
    )
    cell["text_sha256"] = hashlib.sha256(text.encode("utf-8")).hexdigest()
    cell["text_head"] = text[:200]
    passed, per_check = grade_text(task.get("checks", []), text)
    cell["passed"] = passed
    cell["checks"] = per_check
    return cell


def parse_assistant_stream(stdout: str, cell: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Return the last assistant message from a --mode json stream; sum usage."""
    last_assistant: Optional[Dict[str, Any]] = None
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "message_end":
            continue
        message = event.get("message", event)
        if message.get("role") != "assistant":
            continue
        last_assistant = message
        usage = message.get("usage") or {}
        cell["tokens_in"] += int(usage.get("input") or 0)
        cell["tokens_out"] += int(usage.get("output") or 0) + int(usage.get("reasoning") or 0)
    return last_assistant


# ── Provider probing ────────────────────────────────────────────────────────


def probe_provider(provider: str) -> Optional[str]:
    """Return a skip reason when the provider can't serve runs, else None."""
    if provider == "ollama":
        try:
            with urlopen(OLLAMA_PROBE_URL, timeout=3):
                return None
        except Exception as exc:  # noqa: BLE001 — any failure means unreachable
            return f"ollama daemon unreachable at 127.0.0.1:11434 ({type(exc).__name__})"
    key_env = PROVIDER_KEY_ENV.get(provider)
    if key_env and not os.environ.get(key_env):
        # pi also resolves credentials from ~/.pi/agent/auth.json; only skip if
        # neither the env var nor a stored credential for this provider exists.
        auth_path = pi_agent_dir() / "auth.json"
        try:
            auth = json.loads(auth_path.read_text(encoding="utf-8"))
            if isinstance(auth, dict) and provider in auth:
                return None
        except (OSError, json.JSONDecodeError):
            pass
        return f"{key_env} not set (and no {provider} entry in auth.json)"
    return None


# ── Degradation signal (Pattern B: external emitter into penny/signals) ─────


def emit_degradation_signals(rates: Dict[str, Dict[str, Any]]) -> List[str]:
    degraded = {
        fam: r
        for fam, r in rates.items()
        if r["n"] >= MIN_FAMILY_TASKS and r["delta"] < -degradation_margin(r["n"])
    }
    if not degraded:
        return []
    emitted: List[str] = []
    try:
        watchers_dir = str(REPO_ROOT / "scripts" / "system" / "watchers")
        if watchers_dir not in sys.path:
            sys.path.insert(0, watchers_dir)
        from signal_generators import write_signal  # type: ignore[import-not-found]
    except Exception as exc:  # noqa: BLE001 — surfacing is best-effort
        print(f"(could not import write_signal: {type(exc).__name__}: {exc})")
        return []
    stamp = datetime.now(timezone.utc)
    for family, r in sorted(degraded.items()):
        signal = {
            "signal_id": f"prompt_degradation_{family}_{stamp.strftime('%Y%m%d')}",
            "signal_type": "METRIC",
            "source": "prompt_efficacy_runner",
            "priority": "CRITICAL",
            "title": f"Cognitive Frame degrades {family}: {r['delta']:+.0%} vs frame-off",
            "context": (
                f"frame-on {r['on']:.0%} vs frame-off {r['off']:.0%} over {r['n']} golden "
                f"tasks (margin {degradation_margin(r['n']):.0%}). The frame is costing "
                f"this family correctness."
            ),
            "suggested_action": (
                "Run `make evals-prompt-efficacy` with --ablate to find the costly "
                "section, then follow the monitoring guidance in "
                "docs/agents/prompts/cognitive-frame-standards.md (simplify "
                "process-shaped steps only on observed degradation) or add a per-model "
                "prompt variant per plans/per-model-optimization/."
            ),
            "timestamp": stamp.isoformat(),
            "expires": (stamp + timedelta(days=7)).isoformat(),
            "status": "PENDING",
        }
        try:
            drawer = write_signal(signal, session_id="prompt_efficacy_runner")
            if drawer:
                emitted.append(signal["signal_id"])
        except Exception as exc:  # noqa: BLE001
            print(f"(could not write degradation signal for {family}: {exc})")
    return emitted


# ── Orchestration ───────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", default="", help="comma list of provider/model specs")
    parser.add_argument("--tasks", default="", help="comma list of task ids to run")
    parser.add_argument("--trials", type=int, default=1)
    parser.add_argument("--thinking", default="low", help="thinking level pinned across arms")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=int, default=300, help="seconds per cell")
    parser.add_argument(
        "--ablate",
        action="store_true",
        help="also run per-section ablation arms (first resolved model only)",
    )
    parser.add_argument("--dry-run", action="store_true", help="print the matrix and exit")
    parser.add_argument("--no-signal", action="store_true", help="skip writing degradation signals")
    return parser


def select_tasks(golden: Dict[str, Any], tasks_arg: str) -> List[Dict[str, Any]]:
    tasks: List[Dict[str, Any]] = list(golden.get("cases", []))
    if tasks_arg:
        wanted = {t.strip() for t in tasks_arg.split(",") if t.strip()}
        tasks = [t for t in tasks if t["id"] in wanted]
    return tasks


def resolve_models(specs: List[str]) -> Tuple[List[Tuple[str, str]], List[str]]:
    """Return (runnable [(provider, model)], skip notes) after probing providers."""
    models: List[Tuple[str, str]] = []
    skipped: List[str] = []
    probed: Dict[str, Optional[str]] = {}
    for spec in specs:
        provider, model = parse_model_spec(spec)
        if provider not in probed:
            probed[provider] = probe_provider(provider)
        reason = probed[provider]
        if reason:
            skipped.append(f"{spec} — {reason}")
        else:
            models.append((provider, model))
    return models, skipped


def build_arms(
    frame_text: str, models: List[Tuple[str, str]], staging: Path, ablate: bool
) -> List[Tuple[str, Optional[Path], Tuple[Tuple[str, str], ...]]]:
    """Arms: (name, system-prompt file or None, models). Ablations run model[0]."""
    frame_on = staging / "SYSTEM.frame-on.md"
    frame_on.write_text(frame_text, encoding="utf-8")
    arms: List[Tuple[str, Optional[Path], Tuple[Tuple[str, str], ...]]] = [
        ("on", frame_on, tuple(models)),
        ("off", None, tuple(models)),
    ]
    if ablate:
        sections = frame_sections(frame_text)
        if not sections:
            print("WARNING: --ablate found no <system_context> sections; skipping ablation")
        for slug, section_text in sections:
            path = staging / f"SYSTEM.ablate-{slug}.md"
            path.write_text(ablated_frame(frame_text, section_text), encoding="utf-8")
            arms.append((f"ablate:{slug}", path, (models[0],)))
    return arms


def run_matrix(
    matrix: List[Tuple[Dict[str, Any], str, str, str, int, Optional[Path]]],
    workdir: Path,
    thinking: str,
    timeout_s: int,
    workers: int,
) -> List[Dict[str, Any]]:
    cells: List[Dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [
            pool.submit(
                run_cell,
                task,
                provider,
                model,
                arm,
                trial,
                prompt_path,
                workdir,
                thinking,
                timeout_s,
            )
            for task, provider, model, arm, trial, prompt_path in matrix
        ]
        for done, future in enumerate(concurrent.futures.as_completed(futures), 1):
            cell = future.result()
            cells.append(cell)
            status = "ERR " if cell["error"] else ("pass" if cell["passed"] else "fail")
            print(
                f"[{done}/{len(matrix)}] {status} {cell['arm']:<24} "
                f"{cell['family']:<9} {cell['task_id']} ({cell['latency_s']}s)"
            )
    return cells


def pi_version() -> str:
    try:
        return subprocess.run(
            ["pi", "--version"], capture_output=True, text=True, timeout=15
        ).stdout.strip()
    except Exception:  # noqa: BLE001 — metadata only
        return ""


def write_artifact(
    frame_text: str,
    args: argparse.Namespace,
    models: List[Tuple[str, str]],
    skipped: List[str],
    tasks: List[Dict[str, Any]],
    cells: List[Dict[str, Any]],
) -> Dict[str, Any]:
    stamp = datetime.now(timezone.utc)
    artifact = {
        "ts": stamp.isoformat(),
        "runner_version": 1,
        "pi_version": pi_version(),
        "thinking": args.thinking,
        "trials": args.trials,
        "frame_path": str(FRAME_PATH.relative_to(REPO_ROOT)),
        "frame_sha256": hashlib.sha256(frame_text.encode("utf-8")).hexdigest(),
        "task_count": len(tasks),
        "models": [{"provider": p, "model": m, "family": family_of(m)} for p, m in models],
        "skipped_models": skipped,
        "cells": cells,
    }
    artifact["summary"] = {"per_family": family_rates(artifact)}
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    (RESULTS_DIR / f"run-{stamp.strftime('%Y%m%dT%H%M%SZ')}.json").write_text(
        json.dumps(artifact, indent=2) + "\n", encoding="utf-8"
    )
    LATEST_PATH.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    return artifact


def print_summary(
    rates: Dict[str, Dict[str, Any]], cells: List[Dict[str, Any]], ablate: bool
) -> None:
    print(f"\nresults → {LATEST_PATH}")
    print(f"{'family':<10} {'frame-on':>9} {'frame-off':>10} {'delta':>8} {'n':>4}")
    for family, r in sorted(rates.items()):
        print(f"{family:<10} {r['on']:>9.0%} {r['off']:>10.0%} {r['delta']:>+8.0%} {r['n']:>4}")
    if ablate:
        print("\nablation (vs full frame, first model only):")
        base = ablation_rates(cells, "on")
        for arm_name in sorted({c["arm"] for c in cells if c["arm"].startswith("ablate:")}):
            rate = ablation_rates(cells, arm_name)
            if base is not None and rate is not None:
                print(f"  -{arm_name[7:]:<38} {rate:>7.0%}  ({rate - base:+.0%} vs full)")
    errored = [c for c in cells if c["error"]]
    if errored:
        print(f"\n{len(errored)} cell(s) errored; first: {errored[0]['error']}")


def preflight(args: argparse.Namespace, golden: Dict[str, Any]) -> Tuple[Optional[str], int]:
    """Validate inputs and load the frame. Returns (frame_text, 0) or (None, code)."""
    if not select_tasks(golden, args.tasks):
        print("no tasks selected")
        return None, 2
    specs = [s.strip() for s in (args.models or "").split(",") if s.strip()] or list(
        golden.get("default_models", [])
    )
    if not specs:
        print("no models configured (golden_prompt_tasks.json default_models is empty)")
        return None, 2
    if shutil.which("pi") is None:
        print("pi CLI not found on PATH")
        return None, 2
    if not FRAME_PATH.exists():
        print(f"frame not found: {FRAME_PATH}")
        return None, 2
    # Frame-off = pi's built-in default prompt. A GLOBAL ~/.pi/agent/SYSTEM.md
    # would silently become the "off" frame (discovery falls back to it, cwd- and
    # --no-context-files-independent), and a global APPEND_SYSTEM.md would
    # contaminate EVERY arm. Neither exists today, but if one appears the whole
    # matrix is measuring the wrong thing with no error — so refuse to run.
    contaminants = contaminating_global_prompts()
    if contaminants:
        print(
            "REFUSING: global prompt file(s) would corrupt the frame-on/off contrast:\n  "
            + "\n  ".join(str(p) for p in contaminants)
            + "\nMove them aside (or set PI_CODING_AGENT_DIR to a clean config dir) and rerun."
        )
        return None, 2
    return FRAME_PATH.read_text(encoding="utf-8"), 0


def main() -> int:
    args = build_parser().parse_args()

    golden = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    frame_text, code = preflight(args, golden)
    if frame_text is None:
        return code
    tasks = select_tasks(golden, args.tasks)
    specs = [s.strip() for s in (args.models or "").split(",") if s.strip()] or list(
        golden.get("default_models", [])
    )

    models, skipped = resolve_models(specs)
    for note in skipped:
        print(f"SKIP {note}")
    if not models:
        print("no runnable models — nothing to measure")
        return 2

    staging = Path(tempfile.mkdtemp(prefix="penny-prompt-eff-"))
    workdir = staging / "cwd"  # hermetic cwd OUTSIDE the repo: no .pi/, no AGENTS.md
    workdir.mkdir()
    try:
        arms = build_arms(frame_text, models, staging, args.ablate)
        matrix = [
            (task, provider, model, arm_name, trial, prompt_path)
            for arm_name, prompt_path, arm_models in arms
            for provider, model in arm_models
            for task in tasks
            for trial in range(args.trials)
        ]
        ablate_arms = sum(1 for name, _, _ in arms if name.startswith("ablate:"))
        print(
            f"matrix: {len(tasks)} tasks × {args.trials} trial(s) × "
            f"[{len(models)} models × 2 (on/off)"
            + (f" + 1 model × {ablate_arms} ablations" if ablate_arms else "")
            + f"] = {len(matrix)} cells (thinking={args.thinking}, workers={args.workers})"
        )
        if args.dry_run:
            return 0
        cells = run_matrix(matrix, workdir, args.thinking, args.timeout, args.workers)
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    artifact = write_artifact(frame_text, args, models, skipped, tasks, cells)
    rates = artifact["summary"]["per_family"]
    print_summary(rates, cells, args.ablate)

    if not args.no_signal:
        for signal_id in emit_degradation_signals(rates):
            print(f"CRITICAL signal written: {signal_id}")
    return 0


def ablation_rates(cells: List[Dict[str, Any]], arm: str) -> Optional[float]:
    """Pass rate for one arm restricted to the ablation model (the first model)."""
    ablation_models = {c["model"] for c in cells if c["arm"].startswith("ablate:")}
    scores = [
        c["passed"]
        for c in cells
        if c["arm"] == arm and not c["error"] and c["model"] in ablation_models
    ]
    if not scores:
        return None
    return sum(scores) / len(scores)


if __name__ == "__main__":
    raise SystemExit(main())
