"""Memory retrievability — can Penny find what she stored, when it matters?

4,000+ drawers accumulated is worth nothing if recall does not surface the
right one. This eval replays a GOLDEN SET of (query → expected drawer) pairs
through the same smart_search path the model uses and scores hit@5.

The golden set (golden_recall.json) is curated, not generated: whenever recall
fails you in real use — you knew Penny stored something and she could not find
it — add that query and its target drawer as a case. The eval then guards it
forever. Searches pass track_recall=False: measuring recall must not fabricate
the reuse signal the archiver keys retention on.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Tuple

from eval_lib import (
    EVALS_DIR,
    FAIL,
    PASS,
    UP_GOOD,
    EvalResult,
    EvalSkip,
    bridge,
    run_checks,
)

GOLDEN_PATH = EVALS_DIR / "golden_recall.json"
HIT_AT = 5
ABSOLUTE_FLOOR = 0.5  # below this, retrieval is failing outright, baseline or not
MIN_SIMILARITY = 0.15


def load_golden_cases() -> List[Dict[str, Any]]:
    data = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    return list(data.get("cases", []))


def case_hit(case: Dict[str, Any], results: List[Dict[str, Any]]) -> bool:
    expect = case.get("expect", {})
    prefix = expect.get("id_prefix", "")
    room = expect.get("room", "")
    wing = expect.get("wing", "")
    for hit in results[:HIT_AT]:
        if prefix:
            if str(hit.get("id") or "").startswith(prefix):
                return True
            continue
        if room and hit.get("room") != room:
            continue
        if wing and hit.get("wing") != wing:
            continue
        if room or wing:
            return True
    return False


def check_golden_recall() -> EvalResult:
    cases = load_golden_cases()
    if not cases:
        raise EvalSkip("golden_recall.json has no cases")
    misses: List[str] = []
    for case in cases:
        result = bridge().tool_smart_search(
            {
                "query": case["query"],
                "limit": HIT_AT,
                "min_similarity": MIN_SIMILARITY,
                "include_full": False,
                "track_recall": False,
            }
        )
        if result.get("error"):
            raise EvalSkip(f"smart_search unavailable: {result['error']}")
        if not case_hit(case, result.get("results", [])):
            misses.append(case.get("id", case["query"][:40]))
    rate = 1.0 - len(misses) / len(cases)
    detail = f"hit@{HIT_AT} over {len(cases)} curated cases"
    if misses:
        detail += "; missed: " + ", ".join(misses[:6])
    return EvalResult(
        name="retrieval.golden_recall_hit5",
        status=PASS if rate >= ABSOLUTE_FLOOR else FAIL,
        value=round(rate, 4),
        direction=UP_GOOD,
        unit="fraction",
        detail=detail,
    )


CHECKS: List[Tuple[str, Callable[[], EvalResult]]] = [
    ("retrieval.golden_recall_hit5", check_golden_recall),
]


def collect() -> List[EvalResult]:
    return run_checks(CHECKS)
