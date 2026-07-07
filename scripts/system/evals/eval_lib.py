"""Shared plumbing for Penny's eval & regression suite.

The suite measures what actually matters (see README.md — "what better means"),
reading the LIVE stores directly:

  * mempalace (via the memory bridge)   — outcomes, diary, signals, amendments
  * the engine checkpointer             — .penny/orchestration.db
  * the observability database          — sessions, logs, orchestration ingest

Every check returns an :class:`EvalResult`. The runner compares results against
``baseline.json`` (a ratchet): known-broken checks live in ``expected_failures``
so they never block, but anything getting WORSE — a new failure, or a tracked
metric moving past its tolerance in the bad direction — is a regression and
fails the run.

Design notes:
  * Timestamps in the wild here are inconsistent (ISO with/without tz, epoch
    seconds, epoch milliseconds). ``parse_when`` handles all of them; naive
    datetimes are assumed UTC. Never compare raw values across stores.
  * Checks must be READ-ONLY against live stores. Retrieval evals pass
    ``track_recall: False`` so measuring recall does not fabricate reuse.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

EVALS_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVALS_DIR.parents[2]

PASS = "PASS"
FAIL = "FAIL"
SKIP = "SKIP"
ERROR = "ERROR"

DOWN_GOOD = "down_good"
UP_GOOD = "up_good"

# Fields the downstream miners actually consume from an outcome record.
# compression: outcome/reason/domain/decision_id (compression_loop.identify_patterns,
# run_compression._parse_outcome_record); watchers: delta_score/timestamp/decision_id
# (signal_generators); digest: outcome/confidence_at_action (digest/generator.py).
CONSUMED_OUTCOME_FIELDS: Tuple[str, ...] = (
    "decision_id",
    "outcome",
    "domain",
    "reason",
    "session_id",
    "confidence_at_action",
    "timestamp",
)

SUBOPTIMAL = ("MISMATCH", "PARTIAL")
HIGH_CONFIDENCE = ("CERTAIN", "PROBABLE")
LOW_CONFIDENCE = ("POSSIBLE", "UNCERTAIN")


class EvalSkip(Exception):
    """Raised inside a check to mark it SKIP (prerequisite absent, not broken)."""


@dataclass
class EvalResult:
    """One check's outcome. ``value``/``direction`` make it a ratchetable metric."""

    name: str
    status: str
    detail: str = ""
    value: Optional[float] = None
    direction: str = ""
    unit: str = ""
    informational: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "status": self.status,
            "detail": self.detail,
            "value": self.value,
            "direction": self.direction,
            "unit": self.unit,
            "informational": self.informational,
        }


def run_checks(checks: List[Tuple[str, Callable[[], EvalResult]]]) -> List[EvalResult]:
    """Run checks defensively: a crashing check is an ERROR finding, not a crash."""
    results: List[EvalResult] = []
    for name, fn in checks:
        try:
            results.append(fn())
        except EvalSkip as skip:
            results.append(EvalResult(name=name, status=SKIP, detail=str(skip)))
        except Exception as exc:  # noqa: BLE001 — surface, never abort the suite
            results.append(
                EvalResult(name=name, status=ERROR, detail=f"{type(exc).__name__}: {exc}")
            )
    return results


# ── Time handling ───────────────────────────────────────────────────────────


def parse_when(value: Any) -> Optional[datetime]:
    """Parse epoch seconds, epoch milliseconds, or ISO-8601 into aware UTC."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        ts = float(value)
        if ts > 1e12:  # milliseconds
            ts /= 1000.0
        try:
            return datetime.fromtimestamp(ts, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    text = str(value).strip()
    if re.fullmatch(r"\d{10,13}(\.\d+)?", text):
        return parse_when(float(text))
    text = text.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def days_since(value: Any, now: Optional[datetime] = None) -> Optional[float]:
    dt = parse_when(value)
    if dt is None:
        return None
    return ((now or now_utc()) - dt).total_seconds() / 86400.0


def within_days(value: Any, days: float, now: Optional[datetime] = None) -> bool:
    age = days_since(value, now)
    return age is not None and age <= days


# ── Store access ────────────────────────────────────────────────────────────

_BRIDGE: Any = None


def bridge() -> Any:
    """Import the memory bridge lazily (chromadb is heavy)."""
    global _BRIDGE
    if _BRIDGE is None:
        bridge_dir = str(REPO_ROOT / "scripts" / "system" / "bridge")
        if bridge_dir not in sys.path:
            sys.path.insert(0, bridge_dir)
        import memory_bridge  # type: ignore[import-not-found]

        _BRIDGE = memory_bridge
    return _BRIDGE


def _bridge_call(tool: Callable[[dict], dict], params: dict) -> dict:
    result = tool(params)
    if not isinstance(result, dict):
        raise EvalSkip(f"bridge returned non-dict: {result!r}")
    if result.get("error"):
        raise EvalSkip(f"bridge error: {result['error']}")
    return result


def list_drawers_all(
    wing: Optional[str] = None,
    room: Optional[str] = None,
    include_content: bool = False,
    page: int = 10000,
) -> List[Dict[str, Any]]:
    """Page through drawers (the whole store when wing/room are None)."""
    drawers: List[Dict[str, Any]] = []
    offset = 0
    while True:
        params: Dict[str, Any] = {
            "limit": page,
            "offset": offset,
            "include_content": include_content,
        }
        if wing:
            params["wing"] = wing
        if room:
            params["room"] = room
        result = _bridge_call(bridge().tool_list_drawers, params)
        batch = result.get("drawers", [])
        drawers.extend(batch)
        if len(batch) < page:
            return drawers
        offset += page


def load_room(
    room: str,
    wings: Tuple[str, ...] = ("penny", "wing_penny"),
    include_content: bool = False,
) -> List[Dict[str, Any]]:
    """Load a room across the historic penny/wing_penny namespace split."""
    seen: Dict[str, Dict[str, Any]] = {}
    for wing in wings:
        for drawer in list_drawers_all(wing=wing, room=room, include_content=include_content):
            seen[drawer["id"]] = drawer
    return list(seen.values())


def newest_filed_at(drawers: List[Dict[str, Any]]) -> Optional[datetime]:
    stamps = [parse_when(d.get("filed_at")) for d in drawers]
    dated = [s for s in stamps if s is not None]
    return max(dated) if dated else None


# ── Outcome records ─────────────────────────────────────────────────────────


def parse_outcome(text: str) -> Dict[str, Any]:
    """Parse an outcome drawer: JSON body first, header ``key: value`` fallback.

    Mirrors ``run_compression._parse_outcome_record`` semantics (including the
    delta_score→outcome aliasing) so the eval measures what the miners see.
    """
    record: Dict[str, Any] = {}
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                record = parsed
                break
    if not record:
        for fieldname in CONSUMED_OUTCOME_FIELDS + ("delta_score",):
            match = re.search(rf"{fieldname}:\s*([^|\n]*)", text, re.IGNORECASE)
            if match:
                record[fieldname] = match.group(1).strip()
    if not record.get("outcome") and record.get("delta_score"):
        record["outcome"] = record["delta_score"]
    return record


def load_outcomes(window_days: Optional[float] = None) -> List[Dict[str, Any]]:
    """Load parsed outcome records; each carries ``_when`` (aware UTC or None)."""
    outcomes: List[Dict[str, Any]] = []
    cutoff = now_utc() - timedelta(days=window_days) if window_days else None
    for drawer in load_room("outcomes", include_content=True):
        record = parse_outcome(drawer.get("content") or "")
        if not record:
            continue
        when = parse_when(record.get("timestamp")) or parse_when(drawer.get("filed_at"))
        record["_when"] = when
        if cutoff is not None and (when is None or when < cutoff):
            continue
        outcomes.append(record)
    return outcomes


def normalize_reason(record: Dict[str, Any]) -> str:
    """Best-available failure signature for repeat-mistake detection.

    Prefers the ``reason`` field (what the compression loop groups by); falls
    back to actual_outcome / first verify gap so the metric still works while
    the writer does not emit ``reason``.
    """
    for key in ("reason", "actual_outcome"):
        value = str(record.get(key) or "").strip()
        if value and value not in ("met", "not met"):
            return re.sub(r"\s+", " ", value.lower())[:120]
    gaps = record.get("verify_gaps") or []
    if isinstance(gaps, list) and gaps:
        return re.sub(r"\s+", " ", str(gaps[0]).lower())[:120]
    return ""


# ── SQLite stores ───────────────────────────────────────────────────────────


def orch_db_path() -> Path:
    return Path(os.environ.get("PENNY_ORCH_DB") or REPO_ROOT / ".penny" / "orchestration.db")


def obs_db_path() -> Path:
    default = Path.home() / ".local" / "share" / "penny" / "observability" / "observability.db"
    return Path(os.environ.get("PENNY_OBS_DB") or default)


def query_db(path: Path, sql: str, params: Tuple[Any, ...] = ()) -> List[Dict[str, Any]]:
    """Read-only query; SKIPs the check when the store does not exist."""
    if not path.exists():
        raise EvalSkip(f"store not found: {path}")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(sql, params)]
    finally:
        conn.close()


# ── Baseline (the ratchet) ──────────────────────────────────────────────────

KIND_OK = "ok"
KIND_REGRESSION = "regression"
KIND_IMPROVEMENT = "improvement"
KIND_EXPECTED_FAIL = "expected_fail"
KIND_FIXED = "fixed"
KIND_NEW_METRIC = "new_metric"


@dataclass
class Verdict:
    result: EvalResult
    kind: str
    message: str = ""


def load_baseline(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {"expected_failures": {}, "metrics": {}}
    baseline = json.loads(path.read_text(encoding="utf-8"))
    baseline.setdefault("expected_failures", {})
    baseline.setdefault("metrics", {})
    return baseline


def _metric_verdict(result: EvalResult, entry: Dict[str, Any]) -> Tuple[str, str]:
    base = float(entry["value"])
    tolerance = float(entry.get("tolerance", 0.0))
    value = float(result.value)  # type: ignore[arg-type]
    if result.direction == DOWN_GOOD:
        if value > base + tolerance:
            return KIND_REGRESSION, f"{value:g} > baseline {base:g} (+{tolerance:g} tol)"
        if value < base - tolerance:
            return KIND_IMPROVEMENT, f"{value:g} < baseline {base:g}"
    elif result.direction == UP_GOOD:
        if value < base - tolerance:
            return KIND_REGRESSION, f"{value:g} < baseline {base:g} (-{tolerance:g} tol)"
        if value > base + tolerance:
            return KIND_IMPROVEMENT, f"{value:g} > baseline {base:g}"
    return KIND_OK, ""


def compare(results: List[EvalResult], baseline: Dict[str, Any]) -> List[Verdict]:
    """Apply the ratchet rules. Regressions are the only failing kind."""
    expected: Dict[str, Any] = baseline.get("expected_failures", {})
    metrics: Dict[str, Any] = baseline.get("metrics", {})
    verdicts: List[Verdict] = []
    for result in results:
        if result.status == SKIP or result.informational:
            verdicts.append(Verdict(result, KIND_OK))
            continue
        if result.status in (FAIL, ERROR):
            if result.name in expected:
                verdicts.append(Verdict(result, KIND_EXPECTED_FAIL, str(expected[result.name])))
            else:
                verdicts.append(Verdict(result, KIND_REGRESSION, "new failure"))
            continue
        # status PASS from here on
        if result.name in expected:
            verdicts.append(
                Verdict(result, KIND_FIXED, "now passing — remove from expected_failures")
            )
            continue
        if result.value is not None and result.direction:
            entry = metrics.get(result.name)
            if entry is None:
                verdicts.append(Verdict(result, KIND_NEW_METRIC, "no baseline yet"))
            else:
                kind, message = _metric_verdict(result, entry)
                verdicts.append(Verdict(result, kind, message))
            continue
        verdicts.append(Verdict(result, KIND_OK))
    return verdicts


def _default_tolerance(result: EvalResult) -> float:
    if result.unit == "fraction":
        return 0.05
    if result.unit == "days":
        return 1.0
    value = abs(result.value or 0.0)
    return max(2.0, round(0.2 * value, 2))


def update_baseline(baseline: Dict[str, Any], results: List[EvalResult]) -> Dict[str, Any]:
    """Ratchet the baseline: absorb new failures, drop fixed ones, tighten metrics.

    Metric values only ever move in the GOOD direction automatically; loosening
    a baseline is a deliberate human edit of baseline.json.
    """
    expected: Dict[str, Any] = dict(baseline.get("expected_failures", {}))
    metrics: Dict[str, Any] = {k: dict(v) for k, v in baseline.get("metrics", {}).items()}
    for result in results:
        if result.informational or result.status == SKIP:
            continue
        if result.status in (FAIL, ERROR):
            expected.setdefault(result.name, result.detail[:200] or result.status)
        elif result.status == PASS:
            expected.pop(result.name, None)
        if result.value is None or not result.direction or result.status != PASS:
            continue
        entry = metrics.get(result.name)
        if entry is None:
            metrics[result.name] = {
                "value": result.value,
                "tolerance": _default_tolerance(result),
                "direction": result.direction,
                "unit": result.unit,
            }
        else:
            base = float(entry["value"])
            better = result.value < base if result.direction == DOWN_GOOD else result.value > base
            if better:
                entry["value"] = result.value
    return {"expected_failures": expected, "metrics": metrics}
