"""
sca Skill — CVSS 4.0 auto-suggestion (Phase 5).

Standalone, importable. NOTHING here is wired into orchestrate.py yet. No
network, no subprocess.

MODULE NAME: this file is ``cvss4_map.py``, NOT ``cvss.py``. Naming it
``cvss.py`` would SHADOW the real ``cvss`` PyPI package because the skill's
conftest.py inserts ``scripts/`` at ``sys.path[0]``; ``from cvss import CVSS4``
would then import THIS module instead of the library, breaking the mandatory
live-library verification. The behavior (suggest/compute/override) is exactly
the Phase-5 spec; only the filename differs, to keep the real library importable.

Provided primitives:

  VERIFIED_VECTORS
      The 4 tier->vector mappings, LIBRARY-VERIFIED (not hand-rolled). Each
      vector's base_score + severity band is computed by the REAL ``cvss``
      package (see tests/test_cvss.py, which imports ``cvss.CVSS4`` directly and
      asserts each vector produces its claimed score+severity via the library).

  canonical_cvss_tier(tool_severity) -> str
      Shared severity-normalization ADAPTER: translate a tool's NATIVE severity
      vocabulary into the canonical CVSS-tier input vocabulary {critical, high,
      medium, low} BEFORE ``suggest_cvss4_vector`` is called. Canonical tiers
      pass through unchanged; SARIF's ``level`` vocabulary {error, warning, note}
      is translated {high, medium, low} (a POSSIBLE-confidence convention, see
      SARIF_LEVEL_TO_TIER). Any other value is returned UNCHANGED so
      ``suggest_cvss4_vector`` still applies its own conservative LOW fallback.
      Provided as a reusable primitive because the same "raw tool severity ->
      canonical CVSS tier" translation recurs for every NormalizedFinding
      consumer (P2 baseline scan, P8 triage, P12 report).

  suggest_cvss4_vector(tool_severity) -> str
      Case-insensitive map of {critical,high,medium,low} -> verified vector.
      Unrecognized severity falls back CONSERVATIVELY to LOW with a logged
      reason — NEVER escalates to CRITICAL (which would overstate risk). Callers
      holding a NATIVE tool severity (e.g. a SARIF ``level``) MUST first pass it
      through ``canonical_cvss_tier`` or every finding collapses to LOW.

  compute_cvss4_score(vector) -> float | None
      Real-library base score. Returns None on a malformed vector (never a
      fabricated number).

  override_vector(suggested, analyst_vector) -> dict
      Validates an analyst-supplied vector THROUGH the real library. A malformed
      override is rejected with a clear ValueError, never silently accepted.

ANTI-HEURISTIC GUARANTEE (Truth-priority): this module never hand-rolls a CVSS
4.0 scoring algorithm. All scoring goes through the ``cvss`` package, whose
macrovector lookup is the authoritative implementation.
"""

from __future__ import annotations

import logging
from typing import Dict, Optional

from cvss import CVSS4  # the REAL PyPI package (installed in .venv, cvss>=3.6)


logger = logging.getLogger("sca.cvss4")

# Tier -> verified CVSS 4.0 vector. These exact vectors were verified against
# the real ``cvss`` library (base_score + severity band). tests/test_cvss.py
# re-confirms this live so a future library-algorithm drift would fail loudly.
VERIFIED_VECTORS: Dict[str, str] = {
    "critical": "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H",
    "high": "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:L/VA:N/SC:N/SI:N/SA:N",
    "medium": "CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:L/VA:N/SC:N/SI:N/SA:N",
    "low": "CVSS:4.0/AV:L/AC:L/AT:N/PR:L/UI:P/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N",
}

# The canonical CVSS-tier input vocabulary (what suggest_cvss4_vector accepts).
CANONICAL_TIERS = frozenset(VERIFIED_VECTORS)  # {critical, high, medium, low}

# SARIF ``level`` -> canonical CVSS tier. POSSIBLE-CONFIDENCE convention (NOT a
# formally-specified equivalence): SARIF's ``level`` is originally a "how
# blocking is this for CI" signal rather than a pure exploit-severity scale, but
# it is the best severity signal semgrep emits in its SARIF output (real
# ``semgrep scan --sarif`` has NO numeric security-severity field and no
# critical/high/medium/low vocabulary — only ``level`` in {error, warning, note}).
# This is the standard, defensible mapping used to translate that signal.
SARIF_LEVEL_TO_TIER: Dict[str, str] = {
    "error": "high",
    "warning": "medium",
    "note": "low",
}


def canonical_cvss_tier(tool_severity: Optional[str]) -> str:
    """Translate a tool's NATIVE severity vocabulary to a canonical CVSS tier.

    This is the shared severity-normalization ADAPTER that MUST run before
    ``suggest_cvss4_vector`` for any finding whose severity is a native tool
    string. It exists because ``suggest_cvss4_vector`` only understands the
    canonical vocabulary {critical, high, medium, low}; a SARIF-sourced finding
    instead carries a raw SARIF ``level`` {error, warning, note}, so calling
    ``suggest_cvss4_vector`` directly on it collapses EVERY finding to LOW.

    Resolution order (case-insensitive; the two vocabularies do NOT overlap, so
    detection is unambiguous):

      1. Already-canonical tier {critical, high, medium, low}  -> returned as-is
         (e.g. an osv-scanner severity that already speaks this vocabulary).
      2. SARIF ``level`` {error, warning, note}                -> mapped via
         SARIF_LEVEL_TO_TIER (POSSIBLE-confidence convention).
      3. Anything else (typo, 'moderate', 'info', gitleaks' absent severity,
         None, ...)                                            -> returned
         UNCHANGED, so ``suggest_cvss4_vector`` still applies its own
         conservative LOW fallback and logs a reason. This adapter NEVER
         escalates an unrecognized value.

    Reusable by any future NormalizedFinding consumer (P8 triage, P12 report):
    the same raw-severity -> canonical-tier problem recurs everywhere a native
    tool severity feeds CVSS suggestion.

    ROBUSTNESS (Carren-caught): a NON-STRING severity (e.g. OSV's real severity
    is a LIST of CVSS-vector objects, or a dict/None) MUST NOT raise. Any
    non-string input is treated as unrecognized and returned as "" so
    suggest_cvss4_vector still applies its own conservative LOW fallback — the
    adapter never throws and never escalates.
    """
    if not isinstance(tool_severity, str):
        if tool_severity is not None:
            logger.debug(
                "canonical_cvss_tier: non-string severity %r treated as "
                "unrecognized (safe LOW fallback downstream)",
                type(tool_severity).__name__,
            )
        return ""
    key = tool_severity.strip().lower()
    if key in CANONICAL_TIERS:
        return key
    mapped = SARIF_LEVEL_TO_TIER.get(key)
    if mapped is not None:
        logger.debug(
            "canonical_cvss_tier: translated SARIF level %r -> %r "
            "(POSSIBLE-confidence convention)",
            tool_severity,
            mapped,
        )
        return mapped
    # Unrecognized: return the ORIGINAL (string) value untouched.
    # suggest_cvss4_vector will handle it conservatively (LOW) and log. We
    # deliberately do not coerce here so callers/logs still see the true native
    # value.
    return tool_severity


def suggest_cvss4_vector(tool_severity: Optional[str]) -> str:
    """Return the verified CVSS 4.0 vector for ``tool_severity``.

    Case-insensitive match against {critical, high, medium, low}. Any
    unrecognized value (typo, 'INFO', None, ...) falls back CONSERVATIVELY to
    the LOW vector with a logged reason — it NEVER silently escalates to
    CRITICAL, which would overstate risk.

    ROBUSTNESS: a non-string input (list/dict/None/number) is treated as
    unrecognized and falls back to LOW — never raises.
    """
    key = tool_severity.strip().lower() if isinstance(tool_severity, str) else ""
    vector = VERIFIED_VECTORS.get(key)
    if vector is not None:
        return vector
    logger.warning(
        "suggest_cvss4_vector: unrecognized tool_severity %r; falling back to "
        "LOW (conservative; never CRITICAL)",
        tool_severity,
    )
    return VERIFIED_VECTORS["low"]


def compute_cvss4_score(vector: Optional[str]) -> Optional[float]:
    """Return the real-library CVSS 4.0 base score for ``vector``.

    Returns ``None`` (with a logged warning) on any malformed / empty vector —
    never a fabricated number.
    """
    if not isinstance(vector, str) or not vector.strip():
        logger.warning("compute_cvss4_score: empty/non-string vector")
        return None
    try:
        return float(CVSS4(vector).base_score)
    except Exception as exc:  # cvss raises CVSS4Malformed* on bad input
        logger.warning("compute_cvss4_score: malformed vector %r: %s", vector, exc)
        return None


def override_vector(suggested: str, analyst_vector: str) -> dict:
    """Record an analyst override, validating ``analyst_vector`` via the library.

    Returns ``{suggested_vector, analyst_vector, analyst_confirmed: True,
    score}`` where ``score`` is the REAL library base score of the analyst
    vector. A malformed analyst vector is REJECTED with a clear ``ValueError`` —
    never silently accepted.
    """
    score = compute_cvss4_score(analyst_vector)
    if score is None:
        raise ValueError(
            f"analyst-supplied CVSS 4.0 vector is malformed and was rejected: "
            f"{analyst_vector!r}"
        )
    return {
        "suggested_vector": suggested,
        "analyst_vector": analyst_vector,
        "analyst_confirmed": True,
        "score": score,
    }
