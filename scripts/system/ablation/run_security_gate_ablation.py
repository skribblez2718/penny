#!/usr/bin/env python3
"""Security-gate ablation (Bitter-Lesson LOAN disposal, plan-1784127395250 T8).

Disposes the ONE genuinely loan-shaped knob this plan introduced —
``jsa_poc_artifact_capture`` (the T7d capture-in-place harness) — by measuring
it ON vs OFF on labeled fixtures, per the doctrine's "proposes; measurement
disposes". Reuses ``ablate_lib`` plumbing (artifact writer + scaffold
fingerprints); scoring is gate-specific (ablate_lib's field scorer is coupled to
code_detection).

Each fixture is a jsa VERIFY outcome: a set of CLAIMED-verified finding_ids, some
backed by a real browser screenshot on disk and some NOT (a fabricated /
un-captured PoC). The gate SHOULD demote exactly the artifact-less findings.

  * arm ``harness_on``  — ``jsa_poc_artifact_capture`` enabled (default): the
    engine checks the evidence dir and demotes artifact-less findings.
  * arm ``harness_off`` — the LOAN ablated (PENNY_ABLATE_… = 1): no check, every
    claimed finding is confirmed.

The metric is fabrication-detection: does the arm demote exactly the findings
with no engine-captured artifact? ON should; OFF cannot. The knob is a
deterministic PIL decode (ZERO model spend — unlike a dual-verify default-on
which doubles verifier cost), so a measured ON >= OFF is an unambiguous KEEP.

    .venv/bin/python scripts/system/ablation/run_security_gate_ablation.py

Deterministic and hermetic (no live model / network) — safe to re-run.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "apps" / "orchestration" / "src"))

from ablate_lib import fingerprint_files, write_artifact  # noqa: E402

from orchestration.checkpointer import Checkpointer  # noqa: E402
from orchestration.context import RunContext  # noqa: E402
from orchestration.playbooks.jsa import JSAPlaybook, _slug  # noqa: E402

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
ARTIFACT = REPO_ROOT / ".penny" / "ablation" / "security_gate" / "latest.json"
ENV = "PENNY_ABLATE_JSA_POC_ARTIFACT_CAPTURE"
SCAFFOLDS = [
    REPO_ROOT / "apps/orchestration/src/orchestration/playbooks/jsa.py",
    REPO_ROOT / "apps/orchestration/src/orchestration/loans.py",
]

# Labeled fixtures. `with_artifact` findings get a real browser screenshot on
# disk; the rest are CLAIMED-verified with no captured artifact (fabrications the
# gate must catch). truth: demoted == candidates - with_artifact.
SCENARIOS: List[Dict[str, Any]] = [
    {"name": "fabricated_finding", "candidates": ["XSS-1"], "with_artifact": []},
    {"name": "genuine_finding", "candidates": ["XSS-2"], "with_artifact": ["XSS-2"]},
    {"name": "mixed_batch", "candidates": ["XSS-3", "protoPoll #4"], "with_artifact": ["XSS-3"]},
    {"name": "all_fabricated", "candidates": ["A-1", "B-2", "C-3"], "with_artifact": []},
]


def _materialize(scenario: Dict[str, Any], root: Path) -> None:
    """Write a real PNG for each `with_artifact` finding at the deterministic path the engine
    checks; leave the rest absent (a claimed-but-uncaptured PoC)."""
    from PIL import Image

    poc = root / "poc"
    poc.mkdir(parents=True, exist_ok=True)
    for fid in scenario["with_artifact"]:
        Image.new("RGB", (240, 160)).save(poc / f"{_slug(fid)}.png")


def _run_arm(pb: JSAPlaybook, candidates: List[str], output_dir: Path, *, ablated: bool) -> list:
    """The gate's demoted set for one arm. Toggles the real LOAN via its env var."""
    prev = os.environ.get(ENV)
    os.environ[ENV] = "1" if ablated else "0"
    try:
        ctx = RunContext(session_id="ablation", run_id="ablation", playbook="jsa")
        ctx.extras["jsa"] = {"output_dir": str(output_dir)}
        _confirmed, demoted, _checked = pb._poc_partition(ctx, candidates)
        return sorted(demoted)
    finally:
        if prev is None:
            os.environ.pop(ENV, None)
        else:
            os.environ[ENV] = prev


def run(tmp: Path, pb: JSAPlaybook) -> Dict[str, Any]:
    per_case: List[Dict[str, Any]] = []
    arms = {"harness_on": False, "harness_off": True}
    tallies = {a: {"correct": 0, "fabrications_missed": 0} for a in arms}
    for scenario in SCENARIOS:
        root = tmp / scenario["name"]
        _materialize(scenario, root)
        truth_demoted = sorted(set(scenario["candidates"]) - set(scenario["with_artifact"]))
        row: Dict[str, Any] = {"case": scenario["name"], "truth_demoted": truth_demoted}
        for arm, ablated in arms.items():
            pred = _run_arm(pb, scenario["candidates"], root, ablated=ablated)
            correct = pred == truth_demoted
            missed = sorted(set(truth_demoted) - set(pred))  # fabrications the arm let through
            row[arm] = {"demoted": pred, "correct": correct, "fabrications_missed": missed}
            tallies[arm]["correct"] += int(correct)
            tallies[arm]["fabrications_missed"] += len(missed)
        per_case.append(row)
    n = len(SCENARIOS)
    summary = {
        a: {
            "n": n,
            "cases_correct": t["correct"],
            "case_accuracy": round(t["correct"] / n, 4) if n else 0.0,
            "fabrications_missed": t["fabrications_missed"],
        }
        for a, t in tallies.items()
    }
    on, off = summary["harness_on"], summary["harness_off"]
    keep = on["case_accuracy"] >= off["case_accuracy"]
    decision = "KEEP (default-on)" if keep else "DELETE (ablate)"
    return {
        "knob": "jsa_poc_artifact_capture",
        "toggle_env": ENV,
        "fields": ["demoted"],
        "summary": summary,
        "per_case": per_case,
        "cost_note": (
            "deterministic PIL decode — ZERO model/verifier spend (no 2x cost); the only downside of "
            "ON is a benign screenshot mislabeling a finding, which vera's transcript still governs"
        ),
        "decision": decision,
        "rationale": (
            f"ON catches every fabrication ({on['cases_correct']}/{on['n']} cases correct, "
            f"{on['fabrications_missed']} missed); OFF cannot ({off['cases_correct']}/{off['n']}, "
            f"{off['fabrications_missed']} fabrications let through). ON >= OFF at zero model cost."
        ),
    }


def render(data: Dict[str, Any]) -> str:
    lines = [f"security-gate ablation: {data['knob']} (harness ON vs OFF)", ""]
    arms = list(data["summary"].keys())
    header = f"{'case':<20}" + "".join(f"{a:>14}" for a in arms) + "   truth_demoted"
    lines += [header, "-" * len(header)]
    for row in data["per_case"]:
        cells = "".join(f"{('OK' if row[a]['correct'] else 'MISS'):>14}" for a in arms)
        lines.append(f"{row['case']:<20}{cells}   {row['truth_demoted']}")
    lines.append("")
    for a in arms:
        s = data["summary"][a]
        lines.append(
            f"{a:>12}: {s['cases_correct']}/{s['n']} correct "
            f"(acc={s['case_accuracy']:.0%}), fabrications_missed={s['fabrications_missed']}"
        )
    lines += ["", f"decision: {data['decision']} — {data['rationale']}", f"cost: {data['cost_note']}"]
    return "\n".join(lines)


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        cp = Checkpointer(db_path=Path(td) / "orch.db")
        pb = JSAPlaybook(cp)
        data = run(Path(td), pb)
    data["invalidators"] = fingerprint_files([p for p in SCAFFOLDS if p.exists()], REPO_ROOT)
    print(render(data))
    write_artifact(ARTIFACT, data)
    print(f"\nartifact: {ARTIFACT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
