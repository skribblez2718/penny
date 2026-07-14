"""Prompt efficacy — does the Cognitive Frame actually pay rent, per model family?

Penny's prompt architecture claims the universal frame (.pi/SYSTEM.md) raises
task performance across models. This section holds that claim to the same
standard as everything else in the suite: measured, ratcheted, and alive.

Two-part design (the checks here are cheap and cron-safe):

  * ``run_prompt_efficacy.py`` — the EXPENSIVE matrix runner. It replays the
    curated golden task set (golden_prompt_tasks.json) through headless pi,
    frame-on vs frame-off (vs per-section ablations with --ablate), per model
    family, and writes an artifact to ``.penny/evals/prompt_efficacy/``.
    Run it manually or weekly: ``make evals-prompt-efficacy``.
  * This section — reads the LATEST artifact only. No model calls ever happen
    inside ``make evals`` or the ambient cron.

The freshness metric is deliberate (north star N5): a harness nobody runs is
reassurance, not measurement. If the artifact goes stale the ratchet regresses
and the standard eval-regression signal fires.

Grading discipline: graders live here (the runner imports them) and must be
behavior-blind — they score task SUCCESS (right answer, right structure, right
caution), never frame vocabulary. A grader that rewards saying "assumptions"
measures frame compliance, not frame value.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from eval_lib import (
    DOWN_GOOD,
    EVALS_DIR,
    FAIL,
    PASS,
    REPO_ROOT,
    UP_GOOD,
    EvalResult,
    EvalSkip,
    now_utc,
    parse_when,
    run_checks,
)

GOLDEN_PATH = EVALS_DIR / "golden_prompt_tasks.json"
RESULTS_DIR = REPO_ROOT / ".penny" / "evals" / "prompt_efficacy"
LATEST_PATH = RESULTS_DIR / "latest.json"

# A family counts as degraded only when the frame-on deficit exceeds a noise
# margin scaled to the task count: with n tasks one flipped task moves the
# rate by 1/n, so we require at least two net flips (and never less than 5pp).
MIN_FAMILY_TASKS = 8


def degradation_margin(n_tasks: int) -> float:
    if n_tasks <= 0:
        return 1.0
    return max(0.05, 2.0 / n_tasks)


# ── Graders (shared with the runner) ────────────────────────────────────────


def _norm(text: str, check: Dict[str, Any]) -> str:
    return text if check.get("case_sensitive") else text.lower()


def _vals(check: Dict[str, Any]) -> List[str]:
    values = [str(v) for v in check.get("values", [])]
    if not check.get("case_sensitive"):
        values = [v.lower() for v in values]
    return values


def check_text(check: Dict[str, Any], text: str) -> bool:
    """Evaluate one grader check against the model's final text."""
    kind = check.get("type", "")
    if kind == "contains_all":
        hay = _norm(text, check)
        return all(v in hay for v in _vals(check))
    if kind == "contains_any":
        hay = _norm(text, check)
        return any(v in hay for v in _vals(check))
    if kind == "contains_none":
        hay = _norm(text, check)
        return not any(v in hay for v in _vals(check))
    if kind in ("regex", "regex_none"):
        pattern = check.get("pattern")
        if not pattern:
            raise ValueError(f"{kind} check has no pattern")
        flags = 0 if check.get("case_sensitive") else re.IGNORECASE
        found = re.search(pattern, text, flags) is not None
        return found if kind == "regex" else not found
    if kind == "json_fields":
        obj = extract_json_object(text)
        if not isinstance(obj, dict):
            return False
        return all(field in obj for field in check.get("fields", []))
    raise ValueError(f"unknown check type: {kind!r}")


def grade_text(checks: List[Dict[str, Any]], text: str) -> Tuple[bool, Dict[str, bool]]:
    """A task passes iff every check passes. Returns (passed, per-check map)."""
    outcomes: Dict[str, bool] = {}
    for i, check in enumerate(checks):
        key = f"{check.get('type', 'check')}#{i}"
        outcomes[key] = check_text(check, text)
    return all(outcomes.values()) or not outcomes, outcomes


def _balanced_object(text: str, start: int) -> Optional[str]:
    """Return the balanced {...} slice starting at index ``start``, or None.

    String-literal aware: braces inside JSON strings (and escaped quotes) do
    not affect nesting depth, so a value like ``"closes with }"`` cannot
    truncate the object.
    """
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def extract_json_object(text: str) -> Optional[Any]:
    """Find the first parseable JSON object in text (fenced block or braces).

    Tries the fenced ```json block first, then every ``{`` in order until one
    yields a parseable object — so prose braces before the real JSON, or a
    ``}`` inside a string value, do not defeat extraction.
    """
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence:
        try:
            return json.loads(fence.group(1))
        except (json.JSONDecodeError, ValueError):
            pass
    start = text.find("{")
    while start != -1:
        candidate = _balanced_object(text, start)
        if candidate is not None:
            try:
                return json.loads(candidate)
            except (json.JSONDecodeError, ValueError):
                pass
        start = text.find("{", start + 1)
    return None


# ── Artifact access ─────────────────────────────────────────────────────────


def load_golden_tasks(path: Path = GOLDEN_PATH) -> List[Dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return list(data.get("cases", []))


def load_latest() -> Dict[str, Any]:
    if not LATEST_PATH.exists():
        raise EvalSkip("no prompt-efficacy results yet — run `make evals-prompt-efficacy`")
    try:
        data = json.loads(LATEST_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise EvalSkip(f"unreadable results artifact: {exc}")
    if not isinstance(data, dict):
        raise EvalSkip("results artifact is not an object")
    cells = data.get("cells")
    if not isinstance(cells, list) or not cells:
        raise EvalSkip("results artifact has no cells")
    if not all(isinstance(c, dict) for c in cells):
        raise EvalSkip("results artifact cells are malformed")
    return data


def family_rates(artifact: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Recompute per-family pass rates from raw cells (never trust a summary).

    Returns {family: {"on": rate, "off": rate, "delta": d, "n": tasks_scored}}
    using only cells that completed without error, averaging trials per task
    then tasks per family. A task counts only when BOTH arms have a valid cell.
    """
    per: Dict[str, Dict[str, Dict[str, List[bool]]]] = {}
    for cell in artifact.get("cells", []):
        if cell.get("error"):
            continue
        arm = cell.get("arm")
        if arm not in ("on", "off"):
            continue  # ablation arms are runner-report material, not gated here
        family = str(cell.get("family", "unknown"))
        task = str(cell.get("task_id", ""))
        per.setdefault(family, {}).setdefault(task, {}).setdefault(arm, []).append(
            bool(cell.get("passed"))
        )
    rates: Dict[str, Dict[str, Any]] = {}
    for family, tasks in per.items():
        on_scores: List[float] = []
        off_scores: List[float] = []
        for arms in tasks.values():
            if "on" not in arms or "off" not in arms:
                continue
            on_scores.append(sum(arms["on"]) / len(arms["on"]))
            off_scores.append(sum(arms["off"]) / len(arms["off"]))
        if not on_scores:
            continue
        on_rate = sum(on_scores) / len(on_scores)
        off_rate = sum(off_scores) / len(off_scores)
        rates[family] = {
            "on": on_rate,
            "off": off_rate,
            "delta": on_rate - off_rate,
            "n": len(on_scores),
        }
    return rates


# ── Checks ──────────────────────────────────────────────────────────────────


def check_results_fresh() -> EvalResult:
    artifact = load_latest()
    when = parse_when(artifact.get("ts"))
    if when is None:
        raise EvalSkip("results artifact has no parseable ts")
    age_days = max(0.0, (now_utc() - when).total_seconds() / 86400.0)
    return EvalResult(
        name="prompt_efficacy.results_fresh_days",
        status=PASS,
        value=round(age_days, 2),
        direction=DOWN_GOOD,
        unit="days",
        detail="age of latest matrix run; keep the harness alive (target: rerun ≤ every 2 weeks)",
    )


def check_frame_gain_overall() -> EvalResult:
    """INFORMATIONAL: the frame's task-scaffolding value-add (on minus off).

    This is expected to trend toward 0 as models improve — a strong model does
    the task well without the frame's task scaffolding (the Bitter Lesson). A
    shrinking gain is therefore NOT a regression, so this metric no longer gates.
    The capability we actually protect is absolute production-config task success
    (``frame_on_pass_rate``); active harm is caught by ``frame_regressed_families``.
    """
    rates = family_rates(load_latest())
    if not rates:
        raise EvalSkip("no scoreable (on, off) task pairs in latest results")
    deltas = [r["delta"] for r in rates.values()]
    overall = sum(deltas) / len(deltas)
    detail = "; ".join(
        f"{fam}: {r['on']:.0%} on vs {r['off']:.0%} off (n={r['n']})"
        for fam, r in sorted(rates.items())
    )
    return EvalResult(
        name="prompt_efficacy.frame_gain_overall",
        status=PASS,
        value=round(overall, 4),
        unit="fraction",
        informational=True,
        detail=(
            "INFORMATIONAL — mean frame-on minus frame-off pass-rate delta; the "
            "value-add of the frame's task scaffolding, allowed to trend to 0 as "
            f"models improve. Guarded capability: frame_on_pass_rate. — {detail}"
        ),
    )


def check_frame_on_pass_rate() -> EvalResult:
    """INFORMATIONAL summary: mean frame-on (production-config) pass-rate across
    families. This aggregate is ROSTER-SENSITIVE (its mean shifts with which
    families a run includes and can mask one family's collapse), so it no longer
    GATES — it is a convenience number. The gating capability guard is now
    PER-FAMILY (``frame_on_pass_rate.<family>``; see
    ``_frame_on_per_family_results``), which is roster-robust.
    """
    rates = family_rates(load_latest())
    if not rates:
        raise EvalSkip("no scoreable (on, off) task pairs in latest results")
    on_rates = [r["on"] for r in rates.values()]
    overall = sum(on_rates) / len(on_rates)
    detail = "; ".join(
        f"{fam}: {r['on']:.0%} on (n={r['n']})" for fam, r in sorted(rates.items())
    )
    return EvalResult(
        name="prompt_efficacy.frame_on_pass_rate",
        status=PASS,
        value=round(overall, 4),
        unit="fraction",
        informational=True,
        detail=f"INFORMATIONAL — mean frame-on pass-rate across families. — {detail}",
    )


def _frame_on_per_family_results() -> List[EvalResult]:
    """Per-family absolute frame-on floors — the roster-robust capability guard.

    One ratcheted UP_GOOD metric per family (``frame_on_pass_rate.<family>``): a
    single family's collapse trips ITS OWN floor and cannot be hidden behind the
    cross-family mean, and adding/removing a family never moves another family's
    floor. A family absent from a run emits nothing (not checked that run); a NEW
    family is KIND_NEW_METRIC (no baseline yet) until absorbed — never a false
    regression. The aggregate ``check_frame_on_pass_rate`` is informational only.
    """
    try:
        rates = family_rates(load_latest())
    except EvalSkip:
        return []  # the aggregate check already emits the SKIP; avoid double-report
    return [
        EvalResult(
            name=f"prompt_efficacy.frame_on_pass_rate.{fam}",
            status=PASS,
            value=round(r["on"], 4),
            direction=UP_GOOD,
            unit="fraction",
            detail=(
                f"{fam}: frame-on task pass-rate {r['on']:.0%} (n={r['n']}) — "
                "per-family capability floor (roster-robust; ratcheted)"
            ),
        )
        for fam, r in sorted(rates.items())
    ]


def check_frame_regressed_families() -> EvalResult:
    rates = family_rates(load_latest())
    if not rates:
        raise EvalSkip("no scoreable (on, off) task pairs in latest results")
    degraded = [
        f"{fam} ({r['delta']:+.0%}, n={r['n']})"
        for fam, r in sorted(rates.items())
        if r["n"] >= MIN_FAMILY_TASKS and r["delta"] < -degradation_margin(r["n"])
    ]
    return EvalResult(
        name="prompt_efficacy.frame_regressed_families",
        status=PASS if not degraded else FAIL,
        value=float(len(degraded)),
        direction=DOWN_GOOD,
        unit="count",
        detail=(
            "families where the frame measurably HURTS (deficit beyond the 2-task noise "
            "margin): " + (", ".join(degraded) if degraded else "none")
        ),
    )


def check_task_count() -> EvalResult:
    count = len(load_golden_tasks())
    return EvalResult(
        name="prompt_efficacy.task_count",
        status=PASS,
        value=float(count),
        unit="count",
        informational=True,
        detail="curated golden tasks — context only; more tasks shrink the noise margin",
    )


def check_cell_error_rate() -> EvalResult:
    cells = load_latest().get("cells", [])
    if not cells:
        raise EvalSkip("results artifact has no cells")
    errored = sum(1 for c in cells if c.get("error"))
    return EvalResult(
        name="prompt_efficacy.cell_error_rate",
        status=PASS,
        value=round(errored / len(cells), 4),
        unit="fraction",
        informational=True,
        detail=f"{errored}/{len(cells)} matrix cells errored in the latest run (daemon/auth health)",
    )


CHECKS: List[Tuple[str, Callable[[], EvalResult]]] = [
    ("prompt_efficacy.results_fresh_days", check_results_fresh),
    ("prompt_efficacy.frame_gain_overall", check_frame_gain_overall),
    ("prompt_efficacy.frame_on_pass_rate", check_frame_on_pass_rate),
    ("prompt_efficacy.frame_regressed_families", check_frame_regressed_families),
    ("prompt_efficacy.task_count", check_task_count),
    ("prompt_efficacy.cell_error_rate", check_cell_error_rate),
]


def collect() -> List[EvalResult]:
    # CHECKS emits the fixed-name checks (incl. the informational aggregate);
    # per-family floors are appended dynamically (one ratcheted metric per family).
    return run_checks(CHECKS) + _frame_on_per_family_results()
