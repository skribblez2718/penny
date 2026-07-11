"""Pre-apply behavioral-regression guard for the amendment pipeline.

`amendment_applier` whitelists WHERE an amendment may write but can't measure
whether the change makes the system behave worse. This guard gives it teeth:
before applying an amendment, check the latest trajectory run and refuse if the
system has drifted below its accepted baseline (NEW failures) or collapsed
catastrophically.

The fixtures encode Oracle-era behavior; the current (weaker) driver fails some
on day one — that KNOWN gap is captured in the eval baseline
(`trajectory.regressed_fixtures`). The guard blocks only when the failing count
RISES above that baseline (genuine new drift) or the pass rate falls below a
catastrophic floor. Cheap: reads artifacts, never a model call. Fail-open on a
missing/unreadable artifact (absence of evidence ≠ regression).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import List, Optional, Tuple

_ROOT = Path(__file__).resolve().parents[3]
LATEST_PATH = _ROOT / ".penny" / "evals" / "trajectory" / "latest.json"
BASELINE_PATH = _ROOT / "scripts" / "system" / "evals" / "baseline.json"
CATASTROPHIC_FLOOR = 0.4


def _cells(path: Path) -> list:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    return data.get("cells", []) if isinstance(data, dict) else []


def latest_regressions(path: Path = LATEST_PATH) -> List[str]:
    """Fixture ids the current system fails in the latest trajectory run."""
    return [
        str(c.get("id")) for c in _cells(path) if isinstance(c, dict) and c.get("verdict") == "FAIL"
    ]


def _baselined_regression_count(path: Path = BASELINE_PATH) -> Optional[float]:
    """The accepted number of failing fixtures from the eval baseline, or None."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data.get("metrics", {}).get("trajectory.regressed_fixtures", {}).get("value")
    except (json.JSONDecodeError, OSError, AttributeError):
        return None


def check_no_regression(
    path: Path = LATEST_PATH, baseline_path: Path = BASELINE_PATH
) -> Tuple[bool, str]:
    """(ok, message). Blocks when the latest run shows MORE failures than the
    accepted baseline (new drift) or a catastrophic pass rate. Allows the known
    Oracle-vs-driver gap. Fail-open when there's no trajectory evidence yet."""
    cells = _cells(path)
    scored = [c for c in cells if isinstance(c, dict) and c.get("verdict") in ("PASS", "FAIL")]
    if not scored:
        return True, "no trajectory evidence yet — allowed"
    fails = [c["id"] for c in scored if c["verdict"] == "FAIL"]
    rate = 1.0 - len(fails) / len(scored)
    if rate < CATASTROPHIC_FLOOR:
        return False, (
            f"catastrophic behavioral collapse: only {rate:.0%} of fixtures pass "
            f"(failing: {', '.join(fails[:8])}) — resolve before applying amendments"
        )
    accepted = _baselined_regression_count(baseline_path)
    if accepted is not None and len(fails) > accepted:
        return False, (
            f"{len(fails)} fixture(s) failing vs baselined {accepted:.0f} — a NEW "
            f"behavioral regression ({', '.join(fails[:8])}); resolve or re-baseline "
            "with `make trajectory` before applying amendments"
        )
    return True, "no new behavioral regression vs baseline"
