"""Trajectory — is the system still handling Oracle-era tasks at Oracle's quality?

The EXPENSIVE runner (`scripts/system/trajectory/run_trajectory.py`,
`make trajectory`) replays the Oracle-authored fixtures through the current
system and has the calibrated judge score each against its pass bar, writing
`.penny/evals/trajectory/latest.json`. This cheap section reads that artifact —
never a model call — and ratchets:

  * `trajectory.pass_rate` — fraction of fixtures the current system passes.
    RATCHETED (tighten-only baseline catches any decrease) with only a
    catastrophic absolute floor — because the fixtures encode ORACLE behavior and
    the current driver is weaker, so some fail on day one (a known gap, not
    drift). The ratchet guards against getting WORSE than the current baseline.
  * `trajectory.regressed_fixtures` — count of fixtures the current system fails.
    RATCHETED (an increase is the regression), not hard-gated at zero.
  * `trajectory.fixture_count`, `results_fresh_days` — context/liveness.

This is the anti-drift backstop the self-amending flywheel needs: improvements
pass the bar and the ratchet locks them in; drift raises the failure count or
drops the pass rate and is caught.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Tuple

from eval_lib import (
    DOWN_GOOD,
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

LATEST_PATH = REPO_ROOT / ".penny" / "evals" / "trajectory" / "latest.json"
FIXTURES_PATH = REPO_ROOT / "scripts" / "system" / "trajectory" / "fixtures.json"
# The fixtures encode ORACLE-era behavior; the current driver is weaker, so some
# fixtures legitimately fail on day one (the known downgrade, not drift). Both
# metrics therefore RATCHET against the current driver's baseline (tighten-only:
# pass_rate can't fall, regression count can't rise) rather than demanding
# Oracle-equality. CATASTROPHIC_FLOOR is a hard backstop against total collapse.
CATASTROPHIC_FLOOR = 0.4


def load_latest() -> Dict[str, Any]:
    if not LATEST_PATH.exists():
        raise EvalSkip("no trajectory results yet — run `make trajectory`")
    try:
        data = json.loads(LATEST_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise EvalSkip(f"unreadable trajectory artifact: {exc}")
    if not isinstance(data, dict) or not isinstance(data.get("cells"), list):
        raise EvalSkip("trajectory artifact has no cells")
    return data


def _scored(cells: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [c for c in cells if isinstance(c, dict) and c.get("verdict") in ("PASS", "FAIL")]


def check_pass_rate() -> EvalResult:
    scored = _scored(load_latest().get("cells", []))
    if not scored:
        raise EvalSkip("no scored fixtures in the latest trajectory run")
    passed = sum(1 for c in scored if c["verdict"] == "PASS")
    rate = passed / len(scored)
    fails = [c["id"] for c in scored if c["verdict"] == "FAIL"]
    detail = (
        f"{passed}/{len(scored)} fixtures meet their pass bar (ratcheted; floor is catastrophic)"
    )
    if fails:
        detail += "; failing: " + ", ".join(fails[:6])
    # FAIL only on catastrophic collapse; normal drift is caught by the ratchet
    # (a decrease past tolerance vs the baselined current rate).
    return EvalResult(
        name="trajectory.pass_rate",
        status=PASS if rate >= CATASTROPHIC_FLOOR else FAIL,
        value=round(rate, 4),
        direction=UP_GOOD,
        unit="fraction",
        detail=detail,
    )


def check_regressed_fixtures() -> EvalResult:
    """Count of fixtures the CURRENT system fails. Ratcheted, not hard-gated: the
    baseline captures the current driver's known gap; the ratchet alarms if the
    count RISES (new drift), which is the actual regression."""
    scored = _scored(load_latest().get("cells", []))
    if not scored:
        raise EvalSkip("no scored fixtures in the latest trajectory run")
    fails = [c["id"] for c in scored if c["verdict"] == "FAIL"]
    return EvalResult(
        name="trajectory.regressed_fixtures",
        status=PASS,  # ratcheted metric — the tighten-only baseline catches increases
        value=float(len(fails)),
        direction=DOWN_GOOD,
        unit="count",
        detail=(
            "no fixtures failing"
            if not fails
            else f"{len(fails)} failing (baselined; a RISE is the regression): "
            + ", ".join(fails[:8])
        ),
    )


def check_results_fresh() -> EvalResult:
    when = parse_when(load_latest().get("ts"))
    if when is None:
        raise EvalSkip("trajectory artifact has no parseable ts")
    age = max(0.0, (now_utc() - when).total_seconds() / 86400.0)
    return EvalResult(
        name="trajectory.results_fresh_days",
        status=PASS,
        value=round(age, 2),
        direction=DOWN_GOOD,
        unit="days",
        detail="age of the trajectory run; re-run weekly / before adopting an amendment",
    )


def check_route_fidelity() -> EvalResult:
    """Did the system still make the right delegation call (direct vs skill) on
    the fixtures? Informational (per the plan): route divergence is a supporting
    signal, not a gate, unless it correlates with output failure."""
    cells = load_latest().get("cells", [])
    routed = [c for c in cells if isinstance(c, dict) and c.get("route_ok") is not None]
    if not routed:
        raise EvalSkip("no route-fidelity data in the latest run")
    ok = sum(1 for c in routed if c["route_ok"])
    drift = [
        f"{c['id']}({c.get('expected_route')}→{c.get('route')})"
        for c in routed
        if not c["route_ok"]
    ]
    return EvalResult(
        name="trajectory.route_fidelity",
        status=PASS,
        value=round(ok / len(routed), 4),
        direction=UP_GOOD,
        unit="fraction",
        informational=True,
        detail=f"{ok}/{len(routed)} routed correctly"
        + ("; drift: " + ", ".join(drift[:5]) if drift else ""),
    )


def check_fixture_count() -> EvalResult:
    try:
        n = len(json.loads(FIXTURES_PATH.read_text(encoding="utf-8")).get("fixtures", []))
    except (json.JSONDecodeError, OSError):
        n = 0
    return EvalResult(
        name="trajectory.fixture_count",
        status=PASS,
        value=float(n),
        unit="count",
        informational=True,
        detail="Oracle-authored behavioral fixtures — add one whenever you catch drift",
    )


CHECKS: List[Tuple[str, Callable[[], EvalResult]]] = [
    ("trajectory.pass_rate", check_pass_rate),
    ("trajectory.regressed_fixtures", check_regressed_fixtures),
    ("trajectory.route_fidelity", check_route_fidelity),
    ("trajectory.results_fresh_days", check_results_fresh),
    ("trajectory.fixture_count", check_fixture_count),
]


def collect() -> List[EvalResult]:
    return run_checks(CHECKS)
