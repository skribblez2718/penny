#!/usr/bin/env python3
"""Research grounding ablation — the meter for research's SAME_MODEL exception.

``orchestration/independence.py`` registers research's synthia->vera edge as a
same-model bare-judgement verify and states the repayment terms: adopt the
cross-model hook (shipped: ``constraints['validate_model']``) AND measure whether
cross-model should become the DEFAULT. This script is the measurement.

The decision is NOT "are two models better than one?". Making cross-model the default
costs latency on EVERY run, so it must be justified against the slice of defects a
second model could actually affect. Every defect a deterministic floor already decides
is a defect for which the second model contributes nothing.

  * arm ``floor_on``  — ``research.grounding_floor`` runs first: uncited claims,
    dangling citations, and citations to empty sources are settled by arithmetic.
  * arm ``floor_off`` — no deterministic layer; every defect depends on a model
    reading the synthesis.

The metric is *defects decided without a model*. The floor is pure string/set work
(ZERO model spend), so a measured floor_on >= floor_off is an unambiguous KEEP; the
residual it leaves is the only population that can justify cross-model spend.

    .venv/bin/python scripts/system/ablation/run_research_grounding_ablation.py

Deterministic and hermetic (no live model / network) — safe to re-run.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(REPO_ROOT / "apps" / "orchestration" / "src"))
sys.path.insert(0, str(REPO_ROOT / "apps" / "orchestration" / "tests"))

from ablate_lib import fingerprint_files, write_artifact  # noqa: E402

from orchestration.playbooks.research import grounding_floor  # noqa: E402

from research_grounding_corpus import CORPUS, defective  # noqa: E402

ARTIFACT = REPO_ROOT / ".penny" / "ablation" / "research_grounding" / "latest.json"
SCAFFOLDS = [
    REPO_ROOT / "apps/orchestration/src/orchestration/playbooks/research.py",
    REPO_ROOT / "apps/orchestration/src/orchestration/independence.py",
    REPO_ROOT / "apps/orchestration/tests/research_grounding_corpus.py",
]


def _decided_by_floor(case) -> List[str]:
    return grounding_floor(list(case.claims), list(case.sources))


def run() -> Dict[str, Any]:
    defects = defective()
    per_case: List[Dict[str, Any]] = []
    tallies = {"floor_on": 0, "floor_off": 0}
    false_positives = 0

    for case in CORPUS:
        reasons = _decided_by_floor(case)
        is_defect = bool(case.unsupported)
        if not is_defect and reasons:
            false_positives += 1
        if is_defect:
            if reasons:
                tallies["floor_on"] += 1
            # floor_off decides nothing deterministically, by construction.
        per_case.append(
            {
                "case": case.id,
                "tier": case.tier,
                "is_defect": is_defect,
                "truth_unsupported": list(case.unsupported),
                "floor_on": {"decided": bool(reasons), "reasons": reasons},
                "floor_off": {"decided": False, "reasons": []},
                "observed": case.observed,
            }
        )

    n = len(defects)
    residual = n - tallies["floor_on"]
    summary = {
        arm: {
            "n": n,
            "defects_decided_without_a_model": tallies[arm],
            "rate": round(tallies[arm] / n, 4) if n else 0.0,
            "judgement_residual": n - tallies[arm],
        }
        for arm in ("floor_on", "floor_off")
    }
    keep = summary["floor_on"]["rate"] >= summary["floor_off"]["rate"]
    return {
        # `ts` ages the artifact for any freshness consumer; without it the
        # artifact can never be judged fresh.
        "ts": datetime.now(timezone.utc).isoformat(),
        "knob": "research_grounding_floor",
        "toggle_env": None,  # not a registered LOAN: an oracle, not a knowledge table
        "fields": ["decided"],
        "summary": summary,
        "per_case": per_case,
        "false_positives_on_clean_work": false_positives,
        "cost_note": (
            "the floor is pure string/set arithmetic — ZERO model spend. Making cross-model "
            "validation the DEFAULT, by contrast, adds a full verifier pass to every run."
        ),
        "decision": ("KEEP the floor" if keep else "floor adds nothing — drop it"),
        "cross_model_default_guidance": (
            f"{residual}/{n} defects ({round(100 * residual / n) if n else 0}%) are the JUDGEMENT "
            f"RESIDUAL — cited, resolvable, content present, and only a reader can tell the source "
            f"does not support the claim. A second model can only affect those. Do NOT make "
            f"cross-model the default until same- vs cross-model catch rate is measured ON THAT "
            f"SLICE with live models; the opt-in hook (constraints['validate_model']) covers the "
            f"high-stakes case meanwhile."
        ),
        "provenance_warning": (
            "corpus is SYNTHETIC. research runs could not be mined for real grounding failures "
            "until ctx.verify_gaps started being populated (P1); replace these with observed "
            "defects as the ledger fills, and re-run."
        ),
    }


def render(data: Dict[str, Any]) -> str:
    lines = [f"research grounding ablation: {data['knob']} (deterministic floor ON vs OFF)", ""]
    width = max([len(r["case"]) for r in data["per_case"]] + [len("case")]) + 2
    header = f"{'case':<{width}}{'tier':<12}{'floor_on':>12}{'floor_off':>11}"
    lines += [header, "-" * len(header)]
    for row in data["per_case"]:
        if not row["is_defect"]:
            mark_on = "n/a (clean)"
            mark_off = "-"
        else:
            mark_on = "decided" if row["floor_on"]["decided"] else "residual"
            mark_off = "residual"
        lines.append(f"{row['case']:<{width}}{row['tier']:<12}{mark_on:>12}{mark_off:>11}")
    lines.append("")
    for arm in ("floor_on", "floor_off"):
        s = data["summary"][arm]
        lines.append(
            f"{arm:>10}: {s['defects_decided_without_a_model']}/{s['n']} defects decided without a "
            f"model ({s['rate']:.0%}), judgement residual = {s['judgement_residual']}"
        )
    lines += [
        "",
        f"false positives on clean work: {data['false_positives_on_clean_work']}",
        f"decision: {data['decision']}",
        f"cost: {data['cost_note']}",
        "",
        f"cross-model default: {data['cross_model_default_guidance']}",
        "",
        f"provenance: {data['provenance_warning']}",
    ]
    return "\n".join(lines)


def main() -> int:
    data = run()
    data["invalidators"] = fingerprint_files([p for p in SCAFFOLDS if p.exists()], REPO_ROOT)
    print(render(data))
    write_artifact(ARTIFACT, data)
    print(f"\nartifact: {ARTIFACT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
