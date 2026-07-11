#!/usr/bin/env python3
"""Judge-calibration runner — validate the hybrid grader's judge BEFORE it gates.

Grades each hand-labeled response in ``judge_calibration_corpus.jsonl`` with the
fixed judge (``claude-haiku-4-5``) against the matching rubric in
``pilot_rubrics.draft.json``, then reports AGREEMENT with the gold labels and the
FALSE-PASS rate (overall and for the claude-family slice). Mirrors the discipline
of ``scripts/system/judgment/eval_judgment.py``.

Gate (PRD success criteria): the judge may only enable hybrid grading in a default
ratchet-gating efficacy run once agreement >= 0.80 AND false-pass <= 0.20 (overall
and claude slice) AND a human has approved the rubrics + corpus gold labels
(decision #4). This runner PRODUCES that evidence; the human APPROVES it.

Usage::

    .venv/bin/python scripts/system/evals/run_judge_calibration.py            # live judge
    .venv/bin/python scripts/system/evals/run_judge_calibration.py --repeats 3
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prompt_efficacy_judge import make_judge_fn  # noqa: E402

EVALS_DIR = Path(__file__).resolve().parent
CORPUS_PATH = EVALS_DIR / "judge_calibration_corpus.jsonl"
RUBRICS_PATH = EVALS_DIR / "pilot_rubrics.draft.json"

try:  # results next to the other eval artifacts when the repo layout is present
    from eval_lib import REPO_ROOT  # noqa: E402

    RESULTS_DIR = REPO_ROOT / ".penny" / "evals" / "judge_calibration"
except Exception:  # noqa: BLE001 — standalone fallback
    RESULTS_DIR = EVALS_DIR / ".judge_calibration_results"

AGREEMENT_FLOOR = 0.80
FALSE_PASS_CEILING = 0.20

# JudgeFn signature matches prompt_efficacy_judge: (rubric, response) -> (bool|None, info)
ScoreFn = Callable[[Dict[str, Any], str], Tuple[Optional[bool], str]]


# ── loading ─────────────────────────────────────────────────────────────────


def load_corpus(path: Path = CORPUS_PATH) -> List[Dict[str, Any]]:
    """Records from the JSONL corpus; ``_meta`` lines are skipped."""
    records: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        obj = json.loads(line)
        if obj.get("_meta"):
            continue
        records.append(obj)
    return records


def load_corpus_meta(path: Path = CORPUS_PATH) -> Dict[str, Any]:
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            obj = json.loads(line)
            if obj.get("_meta"):
                return obj
    return {}


def load_rubrics(path: Path = RUBRICS_PATH) -> Dict[str, Dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data.get("rubrics", {})


def corpus_approved(meta: Dict[str, Any]) -> bool:
    """True only when a human has signed off the corpus gold labels (decision #4)."""
    ap = (meta or {}).get("approval", {})
    return bool(ap.get("approved_by")) and bool(ap.get("approved_at"))


def rubrics_approved(rubrics_doc: Dict[str, Any]) -> bool:
    ap = (rubrics_doc or {}).get("_approval", {})
    return bool(ap.get("approved_by")) and bool(ap.get("approved_at"))


# ── pure aggregation (unit-tested; no model calls) ──────────────────────────


def compute_metrics(scored: List[Dict[str, Any]]) -> Dict[str, Any]:
    """From scored records ({gold: 'PASS'/'FAIL', verdict: bool|None, family}),
    compute agreement + false-pass (overall and per family). Excluded (verdict is
    None) records are dropped, never counted as agreement or PASS."""
    considered = [s for s in scored if s.get("verdict") is not None]
    excluded = len(scored) - len(considered)
    n = len(considered)
    agree = sum(1 for s in considered if (s["verdict"] is True) == (s["gold"] == "PASS"))
    agreement = (agree / n) if n else 0.0

    fails = [s for s in considered if s["gold"] == "FAIL"]
    fp = sum(1 for s in fails if s["verdict"] is True)
    false_pass_overall = (fp / len(fails)) if fails else 0.0

    by_family: Dict[str, Dict[str, Any]] = {}
    for fam in sorted({s.get("family", "?") for s in considered}):
        fam_fails = [s for s in fails if s.get("family", "?") == fam]
        fam_fp = sum(1 for s in fam_fails if s["verdict"] is True)
        by_family[fam] = {
            "n_fail": len(fam_fails),
            "false_pass": (fam_fp / len(fam_fails)) if fam_fails else 0.0,
        }

    return {
        "n_scored": n,
        "n_excluded": excluded,
        "n_fail": len(fails),
        "agreement": agreement,
        "false_pass_overall": false_pass_overall,
        "false_pass_by_family": by_family,
    }


def gate_verdict(
    metrics: Dict[str, Any],
    *,
    agreement_floor: float = AGREEMENT_FLOOR,
    false_pass_ceiling: float = FALSE_PASS_CEILING,
) -> Tuple[bool, List[str]]:
    """Judge-quality gate: agreement >= floor AND false-pass <= ceiling (overall
    and for the claude slice, when it has any FAIL records)."""
    reasons: List[str] = []
    ok = True
    if metrics["agreement"] < agreement_floor:
        ok = False
        reasons.append(f"agreement {metrics['agreement']:.0%} < floor {agreement_floor:.0%}")
    if metrics["false_pass_overall"] > false_pass_ceiling:
        ok = False
        reasons.append(
            f"false-pass {metrics['false_pass_overall']:.0%} > ceiling {false_pass_ceiling:.0%}"
        )
    claude = metrics["false_pass_by_family"].get("claude")
    if claude and claude["n_fail"] and claude["false_pass"] > false_pass_ceiling:
        ok = False
        reasons.append(
            f"claude-slice false-pass {claude['false_pass']:.0%} > ceiling {false_pass_ceiling:.0%}"
        )
    if ok:
        reasons.append("agreement and false-pass within thresholds")
    return ok, reasons


# ── live scoring ────────────────────────────────────────────────────────────


def score_corpus(records: List[Dict[str, Any]], rubrics: Dict[str, Dict[str, Any]], judge_fn: ScoreFn) -> List[Dict[str, Any]]:
    """Grade each corpus response with judge_fn against its task's rubric."""
    scored: List[Dict[str, Any]] = []
    for r in records:
        rubric = rubrics.get(r.get("task_id", ""))
        if rubric is None:
            scored.append({"id": r.get("id"), "gold": r["gold"], "verdict": None,
                           "family": r.get("family", "?"), "info": "no rubric for task_id"})
            continue
        verdict, info = judge_fn(rubric, r["response"])
        scored.append({"id": r.get("id"), "gold": r["gold"], "verdict": verdict,
                       "family": r.get("family", "?"), "info": info})
    return scored


def run(*, repeats: int = 1, corpus_path: Path = CORPUS_PATH, rubrics_path: Path = RUBRICS_PATH) -> Tuple[bool, Dict[str, Any], List[Dict[str, Any]]]:
    records = load_corpus(corpus_path)
    rubrics = load_rubrics(rubrics_path)
    workdir = tempfile.mkdtemp(prefix="judge-cal-")
    judge_fn = make_judge_fn(cwd=workdir, repeats=max(1, repeats))
    scored = score_corpus(records, rubrics, judge_fn)
    metrics = compute_metrics(scored)
    ok, reasons = gate_verdict(metrics)
    return ok, {**metrics, "gate_pass": ok, "gate_reasons": reasons}, scored


def write_artifact(metrics: Dict[str, Any], scored: List[Dict[str, Any]], approvals: Dict[str, bool]) -> Path:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    artifact = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "agreement_floor": AGREEMENT_FLOOR,
        "false_pass_ceiling": FALSE_PASS_CEILING,
        "approvals": approvals,
        "metrics": metrics,
        "scored": [{k: s.get(k) for k in ("id", "gold", "verdict", "family")} for s in scored],
    }
    path = RESULTS_DIR / "latest.json"
    path.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=1, help="majority-of-N judge calls per record")
    args = parser.parse_args()

    ok, metrics, scored = run(repeats=args.repeats)
    approvals = {
        "rubrics_approved": rubrics_approved(json.loads(RUBRICS_PATH.read_text(encoding="utf-8"))),
        "corpus_approved": corpus_approved(load_corpus_meta()),
    }
    path = write_artifact(metrics, scored, approvals)

    print(f"scored {metrics['n_scored']} record(s), {metrics['n_excluded']} excluded")
    print(f"agreement:  {metrics['agreement']:.0%}  (floor {AGREEMENT_FLOOR:.0%})")
    print(f"false-pass: {metrics['false_pass_overall']:.0%}  (ceiling {FALSE_PASS_CEILING:.0%}, over {metrics['n_fail']} FAIL records)")
    for fam, fm in sorted(metrics["false_pass_by_family"].items()):
        if fm["n_fail"]:
            print(f"  {fam:<9} false-pass {fm['false_pass']:.0%} (n_fail={fm['n_fail']})")
    print(f"GATE: {'PASS' if ok else 'FAIL'} — {'; '.join(metrics['gate_reasons'])}")
    print(f"approvals: rubrics={approvals['rubrics_approved']} corpus={approvals['corpus_approved']} "
          f"(both must be True before hybrid grading may gate a default run)")
    print(f"results → {path}")
    # Exit nonzero if the judge fails its quality gate OR approvals are missing.
    return 0 if (ok and approvals["rubrics_approved"] and approvals["corpus_approved"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
