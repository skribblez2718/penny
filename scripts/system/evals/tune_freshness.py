"""Freshness-gated tune scheduling — lead thresholds and staleness detection.

Defines LEAD_THRESHOLDS (the **single source of truth** for when producers should
be re-run BEFORE the regression gate fires) and ``check_all_stale()`` which reads
``.penny/evals/*/latest.json`` to determine which producers are stale or
invalidated.

Lead thresholds are deliberately set BELOW the ratchet tolerances in
``baseline.json``::

    trajectory:      lead 10d  <  tolerance 14d  (4d gap)
    prompt_efficacy: lead 10d  <  tolerance 14d  (4d gap)
    judgment:        lead 21d  <  tolerance 30d  (9d gap)

This means ``tune_due`` fires a reminder BEFORE the eval regression gate would
catch staleness, giving the user time to re-run producers proactively.

FR-19: prompt_efficacy invalidation — even if age < 10d, the artifact is
reported stale when ``.pi/SYSTEM.md`` mtime is newer than the artifact ts
(frame changed) or the model roster changed. Falls back to age-only on error.
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# Put the evals dir on sys.path so we can import eval_lib.
_EVALS_DIR = Path(__file__).resolve().parent
if str(_EVALS_DIR) not in sys.path:
    sys.path.insert(0, str(_EVALS_DIR))

from eval_lib import REPO_ROOT, parse_when  # noqa: E402

# ---------------------------------------------------------------------------
# Single source of truth — LEAD_THRESHOLDS
# ---------------------------------------------------------------------------

#: Lead thresholds (days) — how soon before the ratchet tolerance a ``tune_due``
#: reminder should fire.  These MUST be < the ratchet tolerances in baseline.json
#: (14/14/30) with >= 3d gap (SM-1).
LEAD_THRESHOLDS: Dict[str, int] = {
    "trajectory": 10,
    "prompt_efficacy": 10,
    "judgment": 21,
}

#: Ratchet tolerances from baseline.json — used for SM-1 verification only.
#: Do NOT duplicate these as literal values in signal_generators.py or tune.md;
#: import LEAD_THRESHOLDS instead.
RATCHET_TOLERANCES: Dict[str, int] = {
    "trajectory": 14,
    "prompt_efficacy": 14,
    "judgment": 30,
}

#: Relative paths from project root to each producer's artifact directory.
PRODUCER_DIRS: Dict[str, str] = {
    "trajectory": ".penny/evals/trajectory",
    "prompt_efficacy": ".penny/evals/prompt_efficacy",
    "judgment": ".penny/evals/judgment",
}

#: Scripts to re-run each producer (for the ``make tune-deep`` CLI entry).
PRODUCER_COMMANDS: Dict[str, str] = {
    "trajectory": "scripts/system/trajectory/run_trajectory.py",
    "prompt_efficacy": "scripts/system/evals/run_prompt_efficacy.py",
    "judgment": "scripts/system/judgment/run_judge_agreement.py",
}

#: Minimum gap (days) between lead threshold and ratchet tolerance (SM-1).
MIN_GAP_DAYS = 3

# ---------------------------------------------------------------------------
# Non-frame ablation artifacts (Bitter-Lesson #3 / #4)
# ---------------------------------------------------------------------------
#
# Unlike the ratchet producers above, an ablation is a *decision aid* (e.g. does
# model-inferred detection beat code_detection.py's hand-coded tables?), not a
# ratcheted metric. It goes stale when the SCAFFOLD it measures changes. Kept
# deliberately OUT of LEAD_THRESHOLDS / PRODUCER_DIRS so the ratchet machinery
# (SM-1) stays about ratcheted metrics only.

#: Relative paths from project root to each ablation artifact directory.
ABLATION_DIRS: Dict[str, str] = {
    "code_detection": ".penny/ablation/code_detection",
}

#: Re-run command per ablation (surfaced, not auto-run — it makes model calls).
ABLATION_COMMANDS: Dict[str, str] = {
    "code_detection": "scripts/system/ablation/run_code_detection_ablation.py",
}

#: A very old ablation is stale even if the scaffold is unchanged.
ABLATION_STALE_DAYS = 30


# ---------------------------------------------------------------------------
# Freshness check
# ---------------------------------------------------------------------------


def check_all_stale(
    project_root: Optional[Path] = None,
    now: Optional[datetime] = None,
    current_models: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Dict[str, Any]]:
    """Check all eval producers for staleness or invalidation.

    Args:
        project_root: Root directory of the project (defaults to REPO_ROOT).
        now: Current UTC datetime (for testing).
        current_models: Optional list of current model dicts for FR-19
            model-roster comparison.  When ``None``, the roster check is
            skipped (age/mtime checks still run).

    Returns:
        ``{producer: {"stale": bool, "reason": str, "age_days": float|None,
         "threshold": int}}``

    Reasons: ``"fresh"``, ``"stale (age)"``,
    ``"invalidated (frame changed)"``, ``"invalidated (model roster changed)"``,
    ``"missing"``, ``"unreadable"``, ``"no ts"``.
    """
    root = Path(project_root) if project_root else REPO_ROOT
    now = now or datetime.now(timezone.utc)

    results: Dict[str, Dict[str, Any]] = {}
    for producer, rel_dir in PRODUCER_DIRS.items():
        artifact_dir = root / rel_dir
        results[producer] = _check_producer(producer, artifact_dir, root, now, current_models)
    return results


def _check_producer(
    producer: str,
    artifact_dir: Path,
    project_root: Path,
    now: datetime,
    current_models: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Check one producer's freshness."""
    threshold = LEAD_THRESHOLDS[producer]
    latest = artifact_dir / "latest.json"

    if not latest.exists():
        return {"stale": True, "reason": "missing", "age_days": None, "threshold": threshold}

    try:
        data = json.loads(latest.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"stale": True, "reason": "unreadable", "age_days": None, "threshold": threshold}

    when = parse_when(data.get("ts"))
    if when is None:
        return {"stale": True, "reason": "no ts", "age_days": None, "threshold": threshold}

    age_days = max(0.0, (now - when).total_seconds() / 86400.0)

    # FR-19: prompt_efficacy invalidation check (before age check so
    # invalidation takes priority even when age < threshold).
    if producer == "prompt_efficacy":
        invalidation = _check_prompt_efficacy_invalidation(data, when, project_root, current_models)
        if invalidation:
            return {
                "stale": True,
                "reason": invalidation,
                "age_days": round(age_days, 2),
                "threshold": threshold,
            }

    if age_days >= threshold:
        return {
            "stale": True,
            "reason": "stale (age)",
            "age_days": round(age_days, 2),
            "threshold": threshold,
        }

    return {
        "stale": False,
        "reason": "fresh",
        "age_days": round(age_days, 2),
        "threshold": threshold,
    }


# ---------------------------------------------------------------------------
# FR-19: prompt_efficacy invalidation
# ---------------------------------------------------------------------------


def _check_prompt_efficacy_invalidation(
    artifact_data: Dict[str, Any],
    artifact_ts: datetime,
    project_root: Path,
    current_models: Optional[List[Dict[str, Any]]] = None,
) -> Optional[str]:
    """FR-19: Check if prompt_efficacy artifact is invalidated.

    Returns a reason string if invalidated, ``None`` otherwise.
    On error (missing/unreadable SYSTEM.md), returns ``None`` so the caller
    falls back to age-only check.

    Invalidation conditions:
      1. ``.pi/SYSTEM.md`` mtime > artifact ts → ``"invalidated (frame changed)"``
      2. ``frame_sha256`` in artifact != hash of current SYSTEM.md
         → ``"invalidated (frame changed)"``
      3. Model roster changed (when ``current_models`` is provided)
         → ``"invalidated (model roster changed)"``
    """
    system_md = project_root / ".pi" / "SYSTEM.md"

    try:
        # Check 1: SYSTEM.md mtime > artifact ts → frame changed
        if system_md.exists():
            mtime = datetime.fromtimestamp(system_md.stat().st_mtime, tz=timezone.utc)
            if mtime > artifact_ts:
                return "invalidated (frame changed)"

        # Check 2: frame_sha256 mismatch → frame changed
        artifact_frame_hash = artifact_data.get("frame_sha256")
        if artifact_frame_hash and system_md.exists():
            current_hash = hashlib.sha256(system_md.read_bytes()).hexdigest()
            if current_hash != artifact_frame_hash:
                return "invalidated (frame changed)"

        # Check 3: model roster changed (only when current_models provided)
        if current_models is not None:
            artifact_models = artifact_data.get("models", [])
            if _model_roster_changed(artifact_models, current_models):
                return "invalidated (model roster changed)"
    except (OSError, ValueError):
        # Fall back to age-only check — do not crash.
        return None

    return None


def _model_roster_hash(models: List[Dict[str, Any]]) -> str:
    """Compute a stable hash of a model roster (sorted by provider/model)."""
    identifiers = sorted(f"{m.get('provider', '')}/{m.get('model', '')}" for m in models)
    return hashlib.sha256("|".join(identifiers).encode()).hexdigest()


def _model_roster_changed(
    artifact_models: List[Dict[str, Any]],
    current_models: List[Dict[str, Any]],
) -> bool:
    """Check if the model roster has changed."""
    return _model_roster_hash(artifact_models) != _model_roster_hash(current_models)


# ---------------------------------------------------------------------------
# Non-frame ablation freshness (Bitter-Lesson #3 / #4)
# ---------------------------------------------------------------------------
#
# Generalizes FR-19's frame-SHA idea: each artifact self-declares ``invalidators``
# (a list of ``{path, sha256}``); the check re-hashes each current file and
# invalidates on any mismatch or missing file. The artifact declares *what*
# invalidates it, so the checker stays generic (no per-scaffold path hard-coded).


def _hash_file(path: Path) -> Optional[str]:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def _check_declared_invalidation(
    artifact_data: Dict[str, Any], project_root: Path
) -> Optional[str]:
    """Re-hash an artifact's self-declared ``invalidators`` (``[{path, sha256}]``);
    return a reason if any current file changed or went missing, else ``None``."""
    invalidators = artifact_data.get("invalidators")
    if not isinstance(invalidators, list):
        return None
    for inv in invalidators:
        if not isinstance(inv, dict):
            continue
        rel = str(inv.get("path", "")).strip()
        recorded = inv.get("sha256")
        if not rel or not recorded:
            continue
        current = _hash_file(project_root / rel)
        if current is None:
            return f"invalidated ({rel} missing)"
        if current != recorded:
            return f"invalidated (scaffold changed: {rel})"
    return None


def _check_ablation(artifact_dir: Path, project_root: Path, now: datetime) -> Dict[str, Any]:
    threshold = ABLATION_STALE_DAYS
    latest = artifact_dir / "latest.json"
    if not latest.exists():
        return {"stale": True, "reason": "missing", "age_days": None, "threshold": threshold}
    try:
        data = json.loads(latest.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"stale": True, "reason": "unreadable", "age_days": None, "threshold": threshold}
    when = parse_when(data.get("ts"))
    if when is None:
        return {"stale": True, "reason": "no ts", "age_days": None, "threshold": threshold}
    age_days = max(0.0, (now - when).total_seconds() / 86400.0)
    invalidation = _check_declared_invalidation(data, project_root)
    if invalidation:
        return {
            "stale": True,
            "reason": invalidation,
            "age_days": round(age_days, 2),
            "threshold": threshold,
        }
    if age_days >= threshold:
        return {
            "stale": True,
            "reason": "stale (age)",
            "age_days": round(age_days, 2),
            "threshold": threshold,
        }
    return {
        "stale": False,
        "reason": "fresh",
        "age_days": round(age_days, 2),
        "threshold": threshold,
    }


def check_ablations_stale(
    project_root: Optional[Path] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Dict[str, Any]]:
    """Freshness of non-frame ablation artifacts (self-declared invalidators +
    age). Same result shape as ``check_all_stale``. Separate from the ratchet
    producers because an ablation is a decision aid, not a ratcheted metric."""
    root = Path(project_root) if project_root else REPO_ROOT
    now = now or datetime.now(timezone.utc)
    return {name: _check_ablation(root / rel, root, now) for name, rel in ABLATION_DIRS.items()}


def _print_ablation_freshness() -> None:
    """Report ablation freshness for ``make tune-deep``. Does NOT auto-run — an
    ablation re-run makes model calls, so surface the command instead."""
    ablations = check_ablations_stale()
    if not ablations:
        return
    print()
    print("Ablation freshness (Bitter-Lesson decision aids; re-run is a model call, not auto):")
    for name, info in ablations.items():
        age = f"{info['age_days']:.1f}d" if info["age_days"] is not None else "?"
        state = "STALE" if info["stale"] else "fresh"
        print(f"  {state:>5}  {name}: {info['reason']} (age {age})")
        if info["stale"]:
            print(f"         -> .venv/bin/python {ABLATION_COMMANDS.get(name, '?')}")


# ---------------------------------------------------------------------------
# Convenience
# ---------------------------------------------------------------------------


def stale_producers(
    project_root: Optional[Path] = None,
    now: Optional[datetime] = None,
    current_models: Optional[List[Dict[str, Any]]] = None,
) -> List[str]:
    """Return list of producer names that are stale or invalidated."""
    results = check_all_stale(project_root, now, current_models)
    return [p for p, info in results.items() if info["stale"]]


# ---------------------------------------------------------------------------
# CLI entry point (``make tune-deep``)
# ---------------------------------------------------------------------------


def main() -> int:
    """Run only stale/invalidated producers with default models.

    Non-interactive: no user prompts, no human-in-the-loop steps.
    Not in cron: invoked manually via ``make tune-deep``.

    SC-7: runs only stale/invalidated producers, no interactive steps,
    not in cron.
    """
    import subprocess

    results = check_all_stale()
    stale = [p for p, info in results.items() if info["stale"]]

    if not stale:
        print("All eval producers are fresh — nothing to re-run.")
        return 0

    print(f"Stale/invalidated producers: {', '.join(stale)}")
    print()

    venv_python = str(REPO_ROOT / ".venv" / "bin" / "python")

    for producer in stale:
        info = results[producer]
        script = PRODUCER_COMMANDS.get(producer)
        if not script:
            print(f"  skip  {producer}: no re-run command configured")
            continue

        script_path = REPO_ROOT / script
        age_str = f"{info['age_days']:.1f}d" if info["age_days"] is not None else "?"
        print(f"  run  {producer}: {info['reason']} (age: {age_str})")
        print(f"       -> .venv/bin/python {script}")

        try:
            proc = subprocess.run(
                [venv_python, str(script_path)],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                timeout=600,
            )
            if proc.returncode == 0:
                print(f"       ok   {producer} completed")
            else:
                print(f"       FAIL {producer} exited {proc.returncode}")
                if proc.stderr:
                    print(f"       stderr: {proc.stderr[:500]}")
        except subprocess.TimeoutExpired:
            print(f"       FAIL {producer} timed out (600s)")
        except (OSError, ValueError) as exc:
            print(f"       FAIL {producer}: {type(exc).__name__}: {exc}")

    _print_ablation_freshness()

    print()
    print("tune-deep complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
