#!/usr/bin/env python3
"""Non-frame ablation harness — shared plumbing (Bitter-Lesson item #3).

Measures a hand-coded scaffold against a model-inferred alternative on a small
set of labeled fixtures, so a proposed Bitter-Lesson change ("retire the tables,
let the model read the artifact") can be scored for regression BEFORE it ships —
the doctrine's "build the meter, measure, then cut".

Detector-agnostic by design: an *arm* is any ``DetectorFn`` (Path -> prediction
dict). The heuristic arm wraps the existing detector; the model arm shells to
headless pi. Tests inject fakes, so the harness is fully verifiable without a
live model call (mirrors the two-part prompt_efficacy design).

Scope note: this is a per-scaffold instrument, NOT a general toggle framework —
speculative generality would itself be the KNOWLEDGE-CONSTRAINT scaffolding the
doctrine warns against. Generalize only when a third scaffold needs it.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

# A detector reads a project directory and returns a prediction dict; on failure
# it should raise — run_arm records the error and scores the case as a miss.
DetectorFn = Callable[[Path], Dict[str, Any]]


@dataclass
class Case:
    name: str
    root: Path
    truth: Dict[str, Any]


@dataclass
class CaseResult:
    case: str
    pred: Optional[Dict[str, Any]]
    field_scores: Dict[str, bool]
    correct: bool
    error: Optional[str] = None


def load_cases(fixtures_dir: Path) -> List[Case]:
    """Load labeled fixtures: ``cases/<name>/`` dirs + a sibling ``truth.json``."""
    truths = json.loads((fixtures_dir / "truth.json").read_text(encoding="utf-8"))
    cases_dir = fixtures_dir / "cases"
    cases: List[Case] = []
    for name, truth in sorted(truths.items()):
        root = cases_dir / name
        if not root.is_dir():
            raise FileNotFoundError(f"fixture dir missing for '{name}': {root}")
        cases.append(Case(name=name, root=root, truth=dict(truth)))
    return cases


def graded_fields(truth: Dict[str, Any], fields: List[str]) -> List[str]:
    """Which fields to score: ``is_server`` always; the rest only when the ground
    truth says it IS a server (framework/language are undefined for a non-server)."""
    if not truth.get("is_server"):
        return [f for f in fields if f == "is_server"]
    return list(fields)


def _norm(value: Any) -> Any:
    return value.lower() if isinstance(value, str) else value


def score_case(pred: Dict[str, Any], truth: Dict[str, Any], fields: List[str]) -> Dict[str, bool]:
    """Field-level correctness (case-insensitive for strings)."""
    return {f: _norm(pred.get(f)) == _norm(truth.get(f)) for f in graded_fields(truth, fields)}


def run_arm(cases: List[Case], detector: DetectorFn, fields: List[str]) -> List[CaseResult]:
    """Run one arm over all cases; a broken detector is a miss, never a crash."""
    results: List[CaseResult] = []
    for case in cases:
        try:
            pred = detector(case.root)
        except Exception as exc:  # noqa: BLE001 — surface as a scored miss
            results.append(
                CaseResult(case.name, None, {}, correct=False, error=f"{type(exc).__name__}: {exc}")
            )
            continue
        scores = score_case(pred, case.truth, fields)
        results.append(
            CaseResult(case.name, pred, scores, correct=bool(scores) and all(scores.values()))
        )
    return results


def summarize(results: List[CaseResult]) -> Dict[str, Any]:
    n = len(results)
    cases_correct = sum(1 for r in results if r.correct)
    fields_total = sum(len(r.field_scores) for r in results)
    fields_correct = sum(sum(1 for v in r.field_scores.values() if v) for r in results)
    return {
        "n": n,
        "cases_correct": cases_correct,
        "case_accuracy": round(cases_correct / n, 4) if n else 0.0,
        "field_accuracy": round(fields_correct / fields_total, 4) if fields_total else 0.0,
        "errors": [r.case for r in results if r.error],
    }


def run_ablation(
    cases: List[Case], arms: Dict[str, DetectorFn], fields: List[str]
) -> Dict[str, Any]:
    per_arm = {name: run_arm(cases, det, fields) for name, det in arms.items()}
    per_case: List[Dict[str, Any]] = []
    for i, case in enumerate(cases):
        row: Dict[str, Any] = {"case": case.name, "truth": case.truth}
        for name, res in per_arm.items():
            r = res[i]
            row[name] = {"pred": r.pred, "correct": r.correct, "error": r.error}
        per_case.append(row)
    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "fields": fields,
        "summary": {name: summarize(res) for name, res in per_arm.items()},
        "per_case": per_case,
    }


def write_artifact(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fingerprint_files(paths: List[Path], repo_root: Path) -> List[Dict[str, str]]:
    """Self-describing invalidators for an artifact: for each file, its repo-
    relative path + sha256. A consumer (tune_freshness) re-hashes the current
    file and compares; any change invalidates the artifact. Generalizes FR-19's
    frame-SHA so an artifact declares *what changes it* (here: the scaffold under
    test), rather than the checker hard-coding a path."""
    out: List[Dict[str, str]] = []
    for p in paths:
        try:
            rel = str(p.resolve().relative_to(repo_root.resolve()))
        except ValueError:
            rel = str(p)
        out.append({"path": rel, "sha256": _sha256_file(p)})
    return out


def render_report(data: Dict[str, Any]) -> str:
    arms = list(data["summary"].keys())
    lines = ["ablation: code_detection (heuristic tables vs model-inferred)", ""]
    header = f"{'case':<20}" + "".join(f"{a:>12}" for a in arms) + "   truth"
    lines += [header, "-" * len(header)]
    for row in data["per_case"]:
        cells = ""
        for a in arms:
            arm = row[a]
            cells += f"{('✓' if arm['correct'] else ('ERR' if arm['error'] else '✗')):>12}"
        truth = row["truth"]
        t = f"is_server={truth.get('is_server')}"
        if truth.get("is_server"):
            t += f",{truth.get('framework')}"
        lines.append(f"{row['case']:<20}{cells}   {t}")
    lines.append("")
    for a in arms:
        s = data["summary"][a]
        line = (
            f"{a:>12}: {s['cases_correct']}/{s['n']} cases correct "
            f"(case_acc={s['case_accuracy']:.0%}, field_acc={s['field_accuracy']:.0%})"
        )
        if s["errors"]:
            line += f"  errors: {s['errors']}"
        lines.append(line)
    summ = data["summary"]
    if "heuristic" in summ and "model" in summ:
        delta = summ["model"]["case_accuracy"] - summ["heuristic"]["case_accuracy"]
        verdict = (
            "→ model matches/beats the tables; evidence to retire them"
            if delta >= 0
            else "→ model worse; keep the tables (or improve the prompt)"
        )
        lines += ["", f"model − heuristic case-accuracy delta: {delta:+.0%}  {verdict}"]
    return "\n".join(lines)
