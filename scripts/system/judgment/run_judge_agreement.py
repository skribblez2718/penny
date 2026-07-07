#!/usr/bin/env python3
"""Judge-agreement runner — measures how well an open model reproduces Fable's verdicts.

Fable's judgment is frozen in ``calibration_corpus.jsonl`` (Fable-authored PASS/FAIL
verdicts on real Penny work products) against ``rubrics.json``. This runner replays
each corpus record through a candidate JUDGE model (headless pi, the grader prompt
in ``judge_prompt.md`` + the class rubric + the work product), parses the judge's
VERDICT, and scores its agreement with Fable — per model, per class.

The metric that matters most is **false_pass_rate**: the fraction of records Fable
FAILED that the judge PASSED. A judge that waves through bad work is the thing that
makes autonomy unsafe; false_fail_rate (too strict) is merely annoying.

    make judge-agreement                     # score the default open-model panel
    .venv/bin/python scripts/system/judgment/run_judge_agreement.py \
        --models ollama/glm-5.2:cloud,ollama/deepseek-v4-pro:cloud

Results land in ``.penny/evals/judgment/latest.json`` where the cheap
``eval_judgment.py`` section ratchets them. Pick the judge with the highest
agreement and lowest false_pass_rate; wire THAT model into the VERIFY primitive so
a weak orchestrator's "is it done?" is backed by a Fable-calibrated verifier.

Why today: the corpus can only be authored while Fable is here. The judge that
reproduces it can be chosen (and re-checked for drift) any day after.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Reuse the proven headless-pi helpers from the prompt-efficacy runner.
_EVALS = Path(__file__).resolve().parents[1] / "evals"
sys.path.insert(0, str(_EVALS))

from run_prompt_efficacy import (  # noqa: E402
    contaminating_global_prompts,
    family_of,
    parse_assistant_stream,
    parse_model_spec,
    probe_provider,
)

JUDGMENT_DIR = Path(__file__).resolve().parent
RUBRICS_PATH = JUDGMENT_DIR / "rubrics.json"
CORPUS_PATH = JUDGMENT_DIR / "calibration_corpus.jsonl"
JUDGE_PROMPT_PATH = JUDGMENT_DIR / "judge_prompt.md"
REPO_ROOT = JUDGMENT_DIR.parents[2]
RESULTS_DIR = REPO_ROOT / ".penny" / "evals" / "judgment"
LATEST_PATH = RESULTS_DIR / "latest.json"

DEFAULT_JUDGES = [
    "ollama/glm-5.2:cloud",
    "ollama/deepseek-v4-pro:cloud",
    "ollama/minimax-m3:cloud",
    "ollama/kimi-k2.7-code:cloud",
]

VERDICT_RE = re.compile(r"verdict\s*[:\-]\s*(pass|fail)", re.IGNORECASE)


def load_corpus() -> List[Dict[str, Any]]:
    records = []
    for line in CORPUS_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            records.append(json.loads(line))
    return records


def load_rubrics() -> Dict[str, Any]:
    return json.loads(RUBRICS_PATH.read_text(encoding="utf-8")).get("rubrics", {})


def build_judge_prompt(record: Dict[str, Any], rubric: Dict[str, Any]) -> str:
    checks = "\n".join(f"- {c}" for c in rubric.get("check", []))
    return (
        "RUBRIC\n"
        f"Question: {rubric.get('question', '')}\n"
        f"Checks:\n{checks}\n"
        f"Pass bar: {rubric.get('pass_bar', '')}\n"
        f"Watch for: {rubric.get('fail_traps', '')}\n\n"
        "WORK PRODUCT\n"
        f"{record['artifact']}\n"
    )


def parse_verdict(text: str) -> Optional[str]:
    # Take the LAST verdict, not the first: a chatty (weak) judge may emit a
    # preliminary "verdict: pass" before its real "VERDICT: FAIL" line, and
    # scoring the first would silently inflate the false-pass safety metric.
    matches = VERDICT_RE.findall(text)
    if matches:
        return matches[-1].upper()
    return None


def judge_record(
    record: Dict[str, Any],
    rubric: Dict[str, Any],
    provider: str,
    model: str,
    system_prompt_path: Path,
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
        "--system-prompt",
        str(system_prompt_path),
        build_judge_prompt(record, rubric),
    ]
    env = dict(os.environ)
    env["PI_SKIP_VERSION_CHECK"] = "1"
    cell: Dict[str, Any] = {
        "id": record["id"],
        "class": record["class"],
        "model": model,
        "family": family_of(model),
        "fable_verdict": record["fable_verdict"],
        "judge_verdict": None,
        "agree": None,
        "error": None,
        "tokens_in": 0,
        "tokens_out": 0,
        "latency_s": 0.0,
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
        return cell
    except OSError as exc:
        cell["error"] = f"spawn failed: {exc}"
        return cell
    cell["latency_s"] = round(time.monotonic() - started, 1)

    last = parse_assistant_stream(proc.stdout, cell)
    if last is None:
        cell["error"] = f"no assistant message (exit {proc.returncode})"
        return cell
    if str(last.get("stopReason", "")) in ("error", "aborted"):
        cell["error"] = f"stopReason={last.get('stopReason')}"
        return cell
    text = "".join(
        b.get("text", "")
        for b in last.get("content", [])
        if isinstance(b, dict) and b.get("type") == "text"
    )
    verdict = parse_verdict(text)
    if verdict is None:
        cell["error"] = "unparseable verdict"
        return cell
    cell["judge_verdict"] = verdict
    cell["agree"] = verdict == record["fable_verdict"]
    return cell


# ── Scoring ──────────────────────────────────────────────────────────────────


def score_model(cells: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Agreement, false-pass/false-fail, kappa, and per-class agreement for one model."""
    scored = [c for c in cells if c["judge_verdict"] is not None and not c["error"]]
    n = len(scored)
    errors = len(cells) - n
    if n == 0:
        return {"n": 0, "errors": errors, "agreement": None}
    agree = sum(1 for c in scored if c["agree"])
    fable_fail = [c for c in scored if c["fable_verdict"] == "FAIL"]
    fable_pass = [c for c in scored if c["fable_verdict"] == "PASS"]
    false_pass = sum(1 for c in fable_fail if c["judge_verdict"] == "PASS")
    false_fail = sum(1 for c in fable_pass if c["judge_verdict"] == "FAIL")
    per_class: Dict[str, Dict[str, int]] = {}
    for c in scored:
        pc = per_class.setdefault(c["class"], {"agree": 0, "n": 0})
        pc["n"] += 1
        pc["agree"] += 1 if c["agree"] else 0
    return {
        "n": n,
        "errors": errors,
        "agreement": agree / n,
        "false_pass_rate": (false_pass / len(fable_fail)) if fable_fail else None,
        "false_fail_rate": (false_fail / len(fable_pass)) if fable_pass else None,
        "kappa": cohen_kappa(scored),
        "per_class": {k: v["agree"] / v["n"] for k, v in sorted(per_class.items())},
    }


def cohen_kappa(scored: List[Dict[str, Any]]) -> Optional[float]:
    n = len(scored)
    if n == 0:
        return None
    po = sum(1 for c in scored if c["agree"]) / n
    fable_pass = sum(1 for c in scored if c["fable_verdict"] == "PASS") / n
    judge_pass = sum(1 for c in scored if c["judge_verdict"] == "PASS") / n
    pe = fable_pass * judge_pass + (1 - fable_pass) * (1 - judge_pass)
    if pe >= 1.0:
        return 1.0 if po >= 1.0 else 0.0
    return round((po - pe) / (1 - pe), 4)


# ── Orchestration ──────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", default="", help="comma list of provider/model judge specs")
    parser.add_argument("--thinking", default="low")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=int, default=300, help="seconds per record")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def resolve_judges(specs: List[str]) -> Tuple[List[Tuple[str, str]], List[str]]:
    judges: List[Tuple[str, str]] = []
    skipped: List[str] = []
    probed: Dict[str, Optional[str]] = {}
    for spec in specs:
        provider, model = parse_model_spec(spec)
        if provider not in probed:
            probed[provider] = probe_provider(provider)
        reason = probed[provider]
        skipped.append(f"{spec} — {reason}") if reason else judges.append((provider, model))
    return judges, skipped


def run_panel(
    judges: List[Tuple[str, str]],
    corpus: List[Dict[str, Any]],
    rubrics: Dict[str, Any],
    system_prompt_path: Path,
    workdir: Path,
    args: argparse.Namespace,
) -> List[Dict[str, Any]]:
    jobs = [
        (record, rubrics[record["class"]], provider, model)
        for provider, model in judges
        for record in corpus
        if record["class"] in rubrics
    ]
    cells: List[Dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [
            pool.submit(
                judge_record,
                record,
                rubric,
                provider,
                model,
                system_prompt_path,
                workdir,
                args.thinking,
                args.timeout,
            )
            for record, rubric, provider, model in jobs
        ]
        for done, future in enumerate(concurrent.futures.as_completed(futures), 1):
            cell = future.result()
            cells.append(cell)
            mark = "ERR " if cell["error"] else ("=" if cell["agree"] else "x")
            print(
                f"[{done}/{len(jobs)}] {mark} {cell['family']:<9} {cell['class']:<22} "
                f"{cell['id']} (fable={cell['fable_verdict']} judge={cell['judge_verdict']})"
            )
    return cells


def summarize(cells: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    by_model: Dict[str, List[Dict[str, Any]]] = {}
    for cell in cells:
        by_model.setdefault(cell["model"], []).append(cell)
    return {model: score_model(mcells) for model, mcells in by_model.items()}


def main() -> int:
    args = build_parser().parse_args()
    corpus = load_corpus()
    rubrics = load_rubrics()
    if not corpus:
        print("empty calibration corpus")
        return 2
    if shutil.which("pi") is None:
        print("pi CLI not found on PATH")
        return 2
    contaminants = contaminating_global_prompts()
    if contaminants:
        # A global SYSTEM.md would prepend to the judge prompt and confound the judge.
        print(
            "REFUSING: global prompt file(s) would confound the judge:\n  "
            + "\n  ".join(str(p) for p in contaminants)
        )
        return 2

    specs = [s.strip() for s in (args.models or "").split(",") if s.strip()] or DEFAULT_JUDGES
    judges, skipped = resolve_judges(specs)
    for note in skipped:
        print(f"SKIP {note}")
    if not judges:
        print("no runnable judge models")
        return 2

    print(
        f"judging {len(corpus)} records × {len(judges)} models = {len(corpus) * len(judges)} calls"
    )
    if args.dry_run:
        return 0

    staging = Path(tempfile.mkdtemp(prefix="penny-judge-"))
    workdir = staging / "cwd"
    workdir.mkdir()
    try:
        cells = run_panel(judges, corpus, rubrics, JUDGE_PROMPT_PATH, workdir, args)
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    per_model = summarize(cells)
    write_artifact(corpus, judges, skipped, cells, per_model)
    print_leaderboard(per_model)
    return 0


def write_artifact(
    corpus: List[Dict[str, Any]],
    judges: List[Tuple[str, str]],
    skipped: List[str],
    cells: List[Dict[str, Any]],
    per_model: Dict[str, Dict[str, Any]],
) -> None:
    stamp = datetime.now(timezone.utc)
    artifact = {
        "ts": stamp.isoformat(),
        "runner_version": 1,
        "corpus_size": len(corpus),
        "corpus_sha256": _sha(CORPUS_PATH),
        "rubrics_sha256": _sha(RUBRICS_PATH),
        "judges": [{"provider": p, "model": m, "family": family_of(m)} for p, m in judges],
        "skipped_models": skipped,
        "per_model": per_model,
        "cells": cells,
    }
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    (RESULTS_DIR / f"run-{stamp.strftime('%Y%m%dT%H%M%SZ')}.json").write_text(
        json.dumps(artifact, indent=2) + "\n", encoding="utf-8"
    )
    LATEST_PATH.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    print(f"\nresults → {LATEST_PATH}")


def _sha(path: Path) -> str:
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()


def print_leaderboard(per_model: Dict[str, Dict[str, Any]]) -> None:
    print(f"\n{'model':<26} {'agree':>7} {'false-pass':>11} {'kappa':>7} {'n':>4}")
    ranked = sorted(
        per_model.items(),
        key=lambda kv: (
            -(kv[1].get("agreement") or 0),
            kv[1].get("false_pass_rate") if kv[1].get("false_pass_rate") is not None else 1,
        ),
    )
    for model, s in ranked:
        if not s.get("n"):
            print(f"{model:<26} {'(no verdicts)':>7}")
            continue
        fp = s.get("false_pass_rate")
        fp_str = f"{fp:.0%}" if fp is not None else "—"
        print(
            f"{model:<26} {s['agreement']:>7.0%} {fp_str:>11} "
            f"{s.get('kappa', 0):>7.2f} {s['n']:>4}"
        )


if __name__ == "__main__":
    raise SystemExit(main())
