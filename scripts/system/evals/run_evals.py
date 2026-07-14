#!/usr/bin/env python3
"""Penny eval & regression runner.

Runs the four eval sections, compares against baseline.json (the ratchet),
prints a scorecard, appends history, and exits non-zero on any REGRESSION —
a new failure, or a tracked metric moving past tolerance in the bad direction.

Usage:
    run_evals.py                         # all sections, gate on regressions
    run_evals.py --sections compat       # deterministic checks only (make test)
    run_evals.py --update-baseline       # absorb current reality into the ratchet
    run_evals.py --signal-on-regression  # also write a CRITICAL penny/signals drawer
    run_evals.py --json                  # machine-readable output

Baseline semantics (baseline.json):
  * expected_failures — checks known broken; they FAIL in the scorecard but do
    not gate. When one starts passing the runner says so: remove the entry (or
    rerun --update-baseline) to lock the fix in as a hard guard.
  * metrics — last accepted value + tolerance per ratcheted metric. Automatic
    updates only ever TIGHTEN (move in the good direction); loosening is a
    deliberate human edit with a git diff to show for it.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent))

import eval_lib  # noqa: E402 — path insert above is required first
from eval_lib import (  # noqa: E402
    ERROR,
    FAIL,
    KIND_EXPECTED_FAIL,
    KIND_FIXED,
    KIND_IMPROVEMENT,
    KIND_NEW_METRIC,
    KIND_REGRESSION,
    PASS,
    SKIP,
    EvalResult,
    Verdict,
    compare,
    load_baseline,
    update_baseline,
)

BASELINE_PATH = eval_lib.EVALS_DIR / "baseline.json"
HISTORY_PATH = eval_lib.REPO_ROOT / ".penny" / "evals" / "history.jsonl"

SECTION_ORDER = (
    "compat",
    "invariants",
    "flywheel",
    "quality",
    "retrieval",
    "prompt_efficacy",
    "judgment",
    "trajectory",
)

STATUS_ICON = {PASS: "✅", FAIL: "❌", SKIP: "⏭️ ", ERROR: "💥"}


def collect_sections(sections: List[str]) -> List[EvalResult]:
    results: List[EvalResult] = []
    for section in sections:
        module = __import__(f"eval_{section}")
        results.extend(module.collect())
    return results


def _format_value(result: EvalResult) -> str:
    if result.value is None:
        return ""
    if result.unit == "fraction":
        return f"{result.value:.2%}"
    if result.unit == "days":
        return f"{result.value:.1f}d"
    return f"{result.value:g}"


def print_scorecard(verdicts: List[Verdict], quiet: bool) -> None:
    marker = {
        KIND_REGRESSION: "  ⟵ REGRESSION",
        KIND_IMPROVEMENT: "  ⟵ improved",
        KIND_FIXED: "  ⟵ FIXED — update baseline",
        KIND_EXPECTED_FAIL: "  (known, baselined)",
        KIND_NEW_METRIC: "  (new metric — run --update-baseline)",
    }
    current_section = ""
    for verdict in verdicts:
        result = verdict.result
        section = result.name.split(".", 1)[0]
        if section != current_section:
            current_section = section
            print(f"\n── {section} " + "─" * (68 - len(section)))
        if quiet and verdict.kind not in (KIND_REGRESSION, KIND_FIXED) and result.status == PASS:
            continue
        value = _format_value(result)
        info = " [info-only]" if result.informational else ""
        line = f"{STATUS_ICON.get(result.status, '?')} {result.name:<42}{value:>10}{info}"
        line += marker.get(verdict.kind, "")
        print(line)
        detail = result.detail or verdict.message
        if detail and (not quiet or verdict.kind == KIND_REGRESSION):
            print(f"     {detail[:160]}")


def append_history(verdicts: List[Verdict]) -> None:
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "results": [v.result.to_dict() for v in verdicts],
        "regressions": [v.result.name for v in verdicts if v.kind == KIND_REGRESSION],
    }
    with HISTORY_PATH.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry) + "\n")


def emit_regression_signal(regressions: List[Verdict]) -> None:
    """Surface regressions through Penny's own signal → session-brief pipeline."""
    try:
        watchers_dir = str(eval_lib.REPO_ROOT / "scripts" / "system" / "watchers")
        if watchers_dir not in sys.path:
            sys.path.insert(0, watchers_dir)
        from signal_generators import write_signal  # type: ignore[import-not-found]

        names = ", ".join(v.result.name for v in regressions[:5])
        stamp = datetime.now(timezone.utc)
        signal = {
            "signal_id": f"eval_regression_{stamp.strftime('%Y%m%d')}",
            "signal_type": "METRIC",
            "source": "eval_runner",
            "priority": "CRITICAL",
            "title": f"Eval regression: {len(regressions)} check(s) got worse",
            "context": names,
            "suggested_action": "Run `make evals` and inspect the regressions before "
            "trusting recent changes.",
            "timestamp": stamp.isoformat(),
            "status": "PENDING",
        }
        write_signal(signal, session_id="eval_runner")
    except Exception as exc:  # noqa: BLE001 — surfacing is best-effort
        print(f"(could not write regression signal: {type(exc).__name__}: {exc})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sections", default=",".join(SECTION_ORDER))
    parser.add_argument("--update-baseline", action="store_true")
    parser.add_argument("--signal-on-regression", action="store_true")
    parser.add_argument("--json", action="store_true", dest="as_json")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--no-history", action="store_true")
    args = parser.parse_args()

    sections = [s.strip() for s in args.sections.split(",") if s.strip()]
    unknown = [s for s in sections if s not in SECTION_ORDER]
    if unknown:
        print(f"unknown sections: {unknown}; valid: {list(SECTION_ORDER)}")
        return 2

    results = collect_sections(sections)
    baseline = load_baseline(BASELINE_PATH)
    verdicts = compare(results, baseline)
    regressions = [v for v in verdicts if v.kind == KIND_REGRESSION]

    if args.as_json:
        print(
            json.dumps(
                {
                    "results": [v.result.to_dict() for v in verdicts],
                    "verdicts": [{"name": v.result.name, "kind": v.kind} for v in verdicts],
                    "regressions": [v.result.name for v in regressions],
                },
                indent=2,
            )
        )
    else:
        print_scorecard(verdicts, args.quiet)
        counts: Dict[str, int] = {}
        for verdict in verdicts:
            counts[verdict.result.status] = counts.get(verdict.result.status, 0) + 1
        summary = "  ".join(f"{k}:{v}" for k, v in sorted(counts.items()))
        print(f"\n{summary}  regressions:{len(regressions)}")

    if not args.no_history:
        append_history(verdicts)

    if args.update_baseline:
        new_baseline = update_baseline(baseline, results)
        BASELINE_PATH.write_text(
            json.dumps(new_baseline, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        print(f"baseline updated: {BASELINE_PATH}")
        return 0

    if regressions:
        if args.signal_on_regression:
            emit_regression_signal(regressions)
        if not args.as_json:
            print("\nREGRESSIONS (worse than baseline):")
            for verdict in regressions:
                print(f"  ❌ {verdict.result.name}: {verdict.message or verdict.result.detail}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
