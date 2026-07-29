"""
Regression tests for graceful CVSS-library degradation (F1).

F1 crashed a whole scan at the first phase with ``ModuleNotFoundError: No module
named 'cvss'`` because ``cvss4_map`` / ``normalize`` imported the ``cvss`` PyPI
package EAGERLY at module load. The fix guards those imports so a missing
library DEGRADES (CVSS scoring -> None, OSV tier -> "unknown") with an
actionable log, and NEVER aborts a scan.

These tests verify:
  * the import guard itself: loading ``cvss4_map`` with ``cvss`` unavailable
    yields ``_CVSS_AVAILABLE=False`` and a None class, scoring returns None, but
    vector *suggestion* (which needs no library) still works;
  * the runtime guards in both modules degrade correctly when the availability
    flag is off;
  * the happy path is unchanged when ``cvss`` IS present (guards the guard).

The import-guard test loads the module under a THROWAWAY name so the real,
already-imported ``cvss4_map`` / ``normalize`` in ``sys.modules`` are never
disturbed for the rest of the suite.
"""

import importlib.util
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(_SCRIPTS))

import cvss4_map  # noqa: E402
import normalize  # noqa: E402


def _load_isolated_without_cvss(script_name: str, probe_name: str):
    """Import ``scripts/<script_name>`` under ``probe_name`` with ``cvss`` made
    unavailable, WITHOUT touching the real module in sys.modules."""
    src = _SCRIPTS / script_name
    sentinel = object()
    saved = sys.modules.get("cvss", sentinel)
    sys.modules["cvss"] = None  # a None entry makes `import cvss` raise ImportError
    try:
        spec = importlib.util.spec_from_file_location(probe_name, src)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[probe_name] = mod
        spec.loader.exec_module(mod)
        return mod
    finally:
        sys.modules.pop(probe_name, None)
        if saved is sentinel:
            sys.modules.pop("cvss", None)
        else:
            sys.modules["cvss"] = saved


def test_cvss4_map_import_guard_degrades_without_crashing():
    probe = _load_isolated_without_cvss("cvss4_map.py", "cvss4_map_probe_nocvss")

    assert probe._CVSS_AVAILABLE is False
    assert probe.CVSS4 is None
    # Scoring degrades to an honest None — never a fabricated number, never a crash.
    assert probe.compute_cvss4_score(probe.VERIFIED_VECTORS["high"]) is None
    # Vector SUGGESTION needs no library and must still work.
    assert probe.suggest_cvss4_vector("high") == probe.VERIFIED_VECTORS["high"]
    assert probe.canonical_cvss_tier("error") == "high"


def test_compute_cvss4_score_degrades_when_flag_off(monkeypatch):
    monkeypatch.setattr(cvss4_map, "_CVSS_AVAILABLE", False)
    assert cvss4_map.compute_cvss4_score(cvss4_map.VERIFIED_VECTORS["critical"]) is None


def test_normalize_osv_tier_degrades_to_unknown_when_flag_off(monkeypatch):
    monkeypatch.setattr(normalize, "_CVSS_AVAILABLE", False)
    vector = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"
    entries = [{"type": "CVSS_V3", "score": vector}]

    assert normalize._cvss_score_and_band("CVSS_V3", vector) is None
    assert normalize._osv_severity_tier(entries) == normalize.DEFAULT_SEVERITY


def test_happy_path_unchanged_when_cvss_present():
    # Guards the guard: with the real library installed, nothing regresses.
    assert cvss4_map._CVSS_AVAILABLE is True
    assert normalize._CVSS_AVAILABLE is True

    score = cvss4_map.compute_cvss4_score(cvss4_map.VERIFIED_VECTORS["critical"])
    assert isinstance(score, float) and score > 0.0

    vector = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"
    parsed = normalize._cvss_score_and_band("CVSS_V3", vector)
    assert parsed is not None
    band_score, band = parsed
    assert isinstance(band_score, float) and band in normalize.CANONICAL_TIERS
