"""
Unit tests for sca cvss.py (Phase 5) — CVSS 4.0 auto-suggestion.

The 4 mapped vectors are LIBRARY-VERIFIED, not hand-rolled: the tests below
import the REAL `cvss.CVSS4` class and assert that each mapped vector actually
produces its claimed base_score and severity band via the library itself. This
is a LIVE-LIBRARY check — it would fail (not silently drift) if a future `cvss`
version changed its scoring algorithm.

Also covered:
  - suggest_cvss4_vector: case-insensitive severity match, conservative LOW
    fallback for unrecognized severities (NEVER escalates to CRITICAL).
  - compute_cvss4_score: real-library score, None on malformed (never fabricated).
  - override_vector: analyst vector validated through the real library; a
    malformed analyst override is rejected, never silently accepted.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from cvss import CVSS4  # noqa: E402  (the REAL PyPI library)

import cvss4_map as sca_cvss  # noqa: E402,F401  (our module)
from cvss4_map import (  # noqa: E402
    VERIFIED_VECTORS,
    SARIF_LEVEL_TO_TIER,
    canonical_cvss_tier,
    suggest_cvss4_vector,
    compute_cvss4_score,
    override_vector,
)


# The authoritative table (tier -> (vector, expected_score, expected_severity)),
# reused verbatim from the IDEAL_STATE. The live-library test proves these.
EXPECTED = {
    "critical": (
        "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H",
        10.0,
        "Critical",
    ),
    "high": (
        "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:L/VA:N/SC:N/SI:N/SA:N",
        8.8,
        "High",
    ),
    "medium": (
        "CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:L/VA:N/SC:N/SI:N/SA:N",
        5.3,
        "Medium",
    ),
    "low": (
        "CVSS:4.0/AV:L/AC:L/AT:N/PR:L/UI:P/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N",
        2.4,
        "Low",
    ),
}


# ── LIVE-LIBRARY verification of the mapping table ───────────────────────


class TestLiveLibraryVerification:
    @pytest.mark.parametrize("tier", ["critical", "high", "medium", "low"])
    def test_vector_produces_claimed_score_and_severity(self, tier):
        vector, expected_score, expected_severity = EXPECTED[tier]
        c = CVSS4(vector)  # the REAL library computes it
        assert c.base_score == expected_score
        assert c.severity == expected_severity

    @pytest.mark.parametrize("tier", ["critical", "high", "medium", "low"])
    def test_module_table_matches_verified_vector(self, tier):
        vector, _, _ = EXPECTED[tier]
        # our module must ship exactly the verified vector, not an approximation
        assert VERIFIED_VECTORS[tier] == vector

    @pytest.mark.parametrize("tier", ["critical", "high", "medium", "low"])
    def test_module_vector_severity_band_matches_tier_label(self, tier):
        # The computed severity band must match the tier LABEL it is mapped to
        # (the anti-heuristic guarantee: no vector is filed under a wrong tier).
        vector = VERIFIED_VECTORS[tier]
        assert CVSS4(vector).severity.lower() == tier


# canonical_cvss_tier (native severity vocab -> canonical tier)
#
# REGRESSION (Phase 6a live-verified bug): SARIF-sourced findings carry a raw
# SARIF `level` string {error, warning, note}, which suggest_cvss4_vector does
# NOT recognize and so collapses to LOW for EVERY semgrep finding regardless of
# true severity. This adapter translates the native SARIF vocabulary into the
# canonical CVSS-tier vocabulary BEFORE suggest_cvss4_vector is called.
#
# CONFIDENCE: the SARIF-level -> tier mapping is POSSIBLE-confidence (a
# defensible convention, not a formally-specified equivalence): SARIF `level` is
# originally a "how blocking for CI" concept, but it is the best severity signal
# semgrep emits. error->high, warning->medium, note->low.


class TestCanonicalCvssTier:
    def test_sarif_level_mapping_table(self):
        # The documented POSSIBLE-confidence convention, exactly.
        assert SARIF_LEVEL_TO_TIER == {
            "error": "high",
            "warning": "medium",
            "note": "low",
        }

    @pytest.mark.parametrize(
        "level,tier",
        [("error", "high"), ("warning", "medium"), ("note", "low")],
    )
    def test_sarif_levels_translate_to_canonical_tier(self, level, tier):
        assert canonical_cvss_tier(level) == tier

    def test_sarif_levels_are_case_insensitive(self):
        assert canonical_cvss_tier("ERROR") == "high"
        assert canonical_cvss_tier("  Warning  ") == "medium"
        assert canonical_cvss_tier("NOTE") == "low"

    @pytest.mark.parametrize("tier", ["critical", "high", "medium", "low"])
    def test_canonical_tiers_pass_through_unchanged(self, tier):
        # A finding that already speaks the canonical vocabulary (e.g. an
        # osv-scanner severity) is returned unchanged.
        assert canonical_cvss_tier(tier) == tier
        assert canonical_cvss_tier(tier.upper()) == tier

    def test_unrecognized_severity_returned_unchanged_for_downstream_fallback(self):
        # canonical_cvss_tier does NOT itself escalate: an unknown vocabulary
        # (e.g. gitleaks has no severity) is passed through so suggest_cvss4_vector
        # applies its own conservative LOW fallback and logs a reason.
        for unknown in ("unknown", "moderate", "info", "", None):
            out = canonical_cvss_tier(unknown)
            assert suggest_cvss4_vector(out) == VERIFIED_VECTORS["low"]

    def test_non_string_severity_does_not_crash(self):
        # Carren's hardening ask: OSV's real severity field is a LIST of
        # CVSS-vector objects, not a word. canonical_cvss_tier must treat any
        # non-string input (list, dict, None, number) as unrecognized and fall
        # through to the safe fallback path, never raise.
        osv_severity = [
            {"type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}
        ]
        for bad in (osv_severity, {"a": 1}, None, 7.5, [], {}):
            out = canonical_cvss_tier(bad)  # must not raise
            assert suggest_cvss4_vector(out) == VERIFIED_VECTORS["low"]

    def test_end_to_end_sarif_error_yields_high_vector_not_low(self):
        # The core bug fix, at the cvss4_map layer: a SARIF level="error"
        # finding must yield the HIGH vector (CVSS 8.8), NOT the LOW vector.
        vector = suggest_cvss4_vector(canonical_cvss_tier("error"))
        assert vector == VERIFIED_VECTORS["high"]
        assert vector != VERIFIED_VECTORS["low"]
        assert compute_cvss4_score(vector) == 8.8

    def test_end_to_end_sarif_warning_and_note(self):
        assert (
            suggest_cvss4_vector(canonical_cvss_tier("warning"))
            == VERIFIED_VECTORS["medium"]
        )
        assert compute_cvss4_score(
            suggest_cvss4_vector(canonical_cvss_tier("warning"))
        ) == 5.3
        assert (
            suggest_cvss4_vector(canonical_cvss_tier("note"))
            == VERIFIED_VECTORS["low"]
        )
        assert compute_cvss4_score(
            suggest_cvss4_vector(canonical_cvss_tier("note"))
        ) == 2.4


# ── suggest_cvss4_vector ─────────────────────────────────────────────────


class TestSuggestVector:
    @pytest.mark.parametrize("tier", ["critical", "high", "medium", "low"])
    def test_returns_verified_vector_for_known_severity(self, tier):
        assert suggest_cvss4_vector(tier) == VERIFIED_VECTORS[tier]

    def test_case_insensitive(self):
        assert suggest_cvss4_vector("CRITICAL") == VERIFIED_VECTORS["critical"]
        assert suggest_cvss4_vector("High") == VERIFIED_VECTORS["high"]
        assert suggest_cvss4_vector("  medium  ") == VERIFIED_VECTORS["medium"]

    def test_unrecognized_falls_back_to_low_never_critical(self, caplog):
        import logging

        with caplog.at_level(logging.WARNING):
            for bad in ("INFO", "typo", "", None, "moderate"):
                out = suggest_cvss4_vector(bad)
                assert out == VERIFIED_VECTORS["low"]
                assert out != VERIFIED_VECTORS["critical"]
        # a clear reason is logged for the fallback
        assert any("fall" in r.message.lower() or "unrecognized" in r.message.lower()
                   for r in caplog.records)


# ── compute_cvss4_score ──────────────────────────────────────────────────


class TestComputeScore:
    @pytest.mark.parametrize("tier", ["critical", "high", "medium", "low"])
    def test_real_score_matches_library(self, tier):
        vector, expected_score, _ = EXPECTED[tier]
        assert compute_cvss4_score(vector) == expected_score

    def test_malformed_returns_none_never_fabricated(self):
        assert compute_cvss4_score("not-a-vector") is None
        assert compute_cvss4_score("CVSS:4.0/AV:Z") is None
        assert compute_cvss4_score("") is None
        assert compute_cvss4_score(None) is None


# ── override_vector ──────────────────────────────────────────────────────


class TestOverrideVector:
    def test_valid_analyst_override_is_scored_via_library(self):
        suggested = VERIFIED_VECTORS["medium"]
        analyst = VERIFIED_VECTORS["critical"]
        out = override_vector(suggested, analyst)
        assert out["suggested_vector"] == suggested
        assert out["analyst_vector"] == analyst
        assert out["analyst_confirmed"] is True
        assert out["score"] == 10.0  # real library score of the analyst vector

    def test_malformed_analyst_override_rejected(self):
        with pytest.raises(ValueError):
            override_vector(VERIFIED_VECTORS["low"], "garbage-vector")

    def test_rejection_message_is_clear(self):
        with pytest.raises(ValueError) as exc:
            override_vector(VERIFIED_VECTORS["low"], "CVSS:4.0/AV:Q")
        assert "malformed" in str(exc.value).lower()
