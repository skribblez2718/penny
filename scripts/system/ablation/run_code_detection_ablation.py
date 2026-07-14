#!/usr/bin/env python3
"""Run the code_detection ablation: heuristic tables vs model-inferred detection.

Expensive/manual (the model arm makes one pi call per fixture) — like
``run_prompt_efficacy.py`` it is never part of ``make evals``. Produces the
ship/no-ship evidence for Bitter-Lesson item #9 (retire code_detection.py's
hand-coded framework/dep tables in favour of model-inferred detection with a
cheap-tier fallback).

    .venv/bin/python scripts/system/ablation/run_code_detection_ablation.py
    ... --arms heuristic                        # heuristic only (no model call)
    ... --model anthropic/claude-haiku-4-5       # pick the (cheap) model arm
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ablate_lib import (  # noqa: E402
    fingerprint_files,
    load_cases,
    render_report,
    run_ablation,
    write_artifact,
)
from detectors import FIELDS, heuristic_detector, model_detector_factory  # noqa: E402

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
FIXTURES = HERE / "fixtures" / "code_detection"
ARTIFACT = REPO_ROOT / ".penny" / "ablation" / "code_detection" / "latest.json"
# The scaffold under test: editing/retiring it invalidates the ablation evidence
# (item #4 — recorded into the artifact as a self-declared invalidator).
SCAFFOLD = REPO_ROOT / "apps/orchestration/src/orchestration/playbooks/code_detection.py"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--arms", default="heuristic,model", help="comma list: heuristic,model")
    ap.add_argument("--model", default="anthropic/claude-haiku-4-5")
    ap.add_argument("--no-artifact", action="store_true")
    args = ap.parse_args()

    cases = load_cases(FIXTURES)
    wanted = [a.strip() for a in args.arms.split(",") if a.strip()]
    arms = {}
    if "heuristic" in wanted:
        arms["heuristic"] = heuristic_detector
    if "model" in wanted:
        arms["model"] = model_detector_factory(args.model)
    if not arms:
        print("no arms selected (use --arms heuristic,model)")
        return 2

    data = run_ablation(cases, arms, FIELDS)
    data["model_spec"] = args.model if "model" in arms else None
    if SCAFFOLD.exists():
        data["invalidators"] = fingerprint_files([SCAFFOLD], REPO_ROOT)
    print(render_report(data))
    if not args.no_artifact:
        write_artifact(ARTIFACT, data)
        print(f"\nartifact: {ARTIFACT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
