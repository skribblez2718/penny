"""Tests for the lane router (lane_router.py)."""

import sys
from pathlib import Path

import pytest

# Add the scripts directory to the path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from lane_router import (
    LANE_CONFIGS,
    ANALYZER_TO_LANE,
    LANE_CODE_STATIC,
    LANE_PAGE_DOM,
    LANE_NETWORK_BEHAVIOR,
    get_lane_for_analyzer,
    get_lane_config,
    get_packet_type_for_lane,
    get_all_analyzers,
    get_lane_summary,
    select_lane,
)


class TestLaneConfig:
    """Tests for lane configuration."""

    def test_lane_configs_defined(self):
        assert LANE_CODE_STATIC in LANE_CONFIGS
        assert LANE_PAGE_DOM in LANE_CONFIGS
        assert LANE_NETWORK_BEHAVIOR in LANE_CONFIGS

    def test_code_static_has_expected_analyzers(self):
        config = LANE_CONFIGS[LANE_CODE_STATIC]
        assert "dom_xss" in config.analyzers
        assert "prototype_pollution" in config.analyzers
        assert "postmessage" in config.analyzers
        assert "open_redirect" in config.analyzers
        # Previously unrouted (defaulted to code_static); now explicitly assigned.
        for a in ("ssrf", "sqli", "http_header_injection", "insecure_deserialization"):
            assert a in config.analyzers

    def test_page_dom_has_expected_analyzers(self):
        config = LANE_CONFIGS[LANE_PAGE_DOM]
        assert "dom_clobbering" in config.analyzers
        assert "reflected_xss" in config.analyzers
        assert "stored_xss" in config.analyzers
        assert "csrf" not in config.analyzers  # csrf is a single class in network_behavior

    def test_network_behavior_has_expected_analyzers(self):
        config = LANE_CONFIGS[LANE_NETWORK_BEHAVIOR]
        assert "cors" in config.analyzers
        assert "clickjacking" in config.analyzers
        assert "idor" in config.analyzers
        assert "cache_poisoning" in config.analyzers
        assert "http_smuggling" in config.analyzers
        # CSRF verification needs HTTP request/response history (token/origin check).
        assert "csrf" in config.analyzers

    def test_packet_types_per_lane(self):
        assert LANE_CONFIGS[LANE_CODE_STATIC].packet_type == "flow_card"
        assert LANE_CONFIGS[LANE_PAGE_DOM].packet_type == "page_card_with_flow_cards"
        assert LANE_CONFIGS[LANE_NETWORK_BEHAVIOR].packet_type == "page_card_with_caido_history"

    def test_no_duplicate_analyzer(self):
        """An analyzer should not be in multiple lanes."""
        seen = {}
        for lane_name, config in LANE_CONFIGS.items():
            for analyzer in config.analyzers:
                if analyzer in seen:
                    raise AssertionError(
                        f"Analyzer {analyzer!r} in multiple lanes: "
                        f"{seen[analyzer]} and {lane_name}"
                    )
                seen[analyzer] = lane_name


class TestAnalyzerToLane:
    """Tests for the ANALYZER_TO_LANE reverse index."""

    def test_all_lane_analyzers_in_index(self):
        for lane_name, config in LANE_CONFIGS.items():
            for analyzer in config.analyzers:
                assert analyzer in ANALYZER_TO_LANE
                assert ANALYZER_TO_LANE[analyzer] == lane_name

    def test_unassigned_analyzer_returns_none(self):
        assert get_lane_for_analyzer("not_a_real_analyzer") is None
        assert get_lane_for_analyzer("") is None

    def test_dom_xss_is_code_static(self):
        assert get_lane_for_analyzer("dom_xss") == LANE_CODE_STATIC

    def test_csrf_is_network_behavior(self):
        assert get_lane_for_analyzer("csrf") == LANE_NETWORK_BEHAVIOR

    def test_previously_unrouted_classes_are_code_static(self):
        for a in ("ssrf", "sqli", "http_header_injection", "insecure_deserialization"):
            assert get_lane_for_analyzer(a) == LANE_CODE_STATIC

    def test_cors_is_network_behavior(self):
        assert get_lane_for_analyzer("cors") == LANE_NETWORK_BEHAVIOR

    def test_dom_clobbering_is_page_dom(self):
        assert get_lane_for_analyzer("dom_clobbering") == LANE_PAGE_DOM


class TestHelperFunctions:
    """Tests for helper functions."""

    def test_get_lane_config_valid(self):
        config = get_lane_config(LANE_CODE_STATIC)
        assert config is not None
        assert config.name == LANE_CODE_STATIC

    def test_get_lane_config_invalid(self):
        assert get_lane_config("nonexistent_lane") is None

    def test_get_packet_type_for_lane(self):
        assert get_packet_type_for_lane(LANE_CODE_STATIC) == "flow_card"
        assert get_packet_type_for_lane(LANE_PAGE_DOM) == "page_card_with_flow_cards"
        assert get_packet_type_for_lane(LANE_NETWORK_BEHAVIOR) == "page_card_with_caido_history"
        assert get_packet_type_for_lane("nonexistent") is None

    def test_get_all_analyzers(self):
        all_analyzers = get_all_analyzers()
        assert isinstance(all_analyzers, list)
        # 22 vuln-class analyzers, 1:1 with the analyzer files and prompts:
        # 13 code_static + 3 page_dom + 6 network_behavior.
        assert len(all_analyzers) == 22
        assert len(set(all_analyzers)) == 22  # no duplicates
        for a in ["dom_xss", "prototype_pollution", "cors", "csrf", "ssrf", "sqli"]:
            assert a in all_analyzers

    def test_get_lane_summary(self):
        summary = get_lane_summary()
        assert LANE_CODE_STATIC in summary
        assert LANE_PAGE_DOM in summary
        assert LANE_NETWORK_BEHAVIOR in summary
        for lane_name, analyzers in summary.items():
            assert isinstance(analyzers, list)
            assert len(analyzers) > 0


class TestLaneRouterMatchesImplementation:
    """Drift guard: the lane router's analyzer set MUST equal the actual analyzer
    implementations AND the per-class reference catalogs (they are 1:1:1). This is
    what prevents the router from silently omitting a class (or inventing a phantom
    one) again.

    NOTE: the per-class *worker prompts* (assets/prompts/annie-<class>.md) were
    retired — their knowledge was harvested into the reference catalogs, which is
    what annie actually reads (the INVESTIGATE task names assets/references/<class>.md
    per candidate class). The catalogs are therefore the correct 1:1 drift target."""

    _SKILL = Path(__file__).parent.parent

    def _analyzer_impls(self):
        d = self._SKILL / "scripts" / "analyzers"
        return {p.stem for p in d.glob("*.py") if p.stem not in ("__init__", "base", "verifier")}

    def _reference_classes(self):
        d = self._SKILL / "assets" / "references"
        return {p.stem for p in d.glob("*.md") if p.stem != "INDEX"}

    def test_lane_set_matches_analyzer_implementations(self):
        # True 1:1:1 — every routed class has an analyzer file and vice versa.
        assert set(get_all_analyzers()) == self._analyzer_impls()

    def test_lane_set_matches_reference_catalogs(self):
        # Every routed class has a reference catalog annie reads, and vice versa.
        assert set(get_all_analyzers()) == self._reference_classes()


class TestSelectLane:
    """Tests for select_lane function."""

    def test_select_lane_from_dict(self):
        flow_card = {"vulnerability_class": "dom_xss"}
        assert select_lane(flow_card) == LANE_CODE_STATIC

    def test_select_lane_from_object(self):
        class FakeCard:
            vulnerability_class = "cors"
        assert select_lane(FakeCard()) == LANE_NETWORK_BEHAVIOR

    def test_select_lane_unassigned_falls_back_to_code_static(self):
        # Unassigned vuln class falls back to code_static (most flexible)
        flow_card = {"vulnerability_class": "unassigned_vuln_class"}
        assert select_lane(flow_card) == LANE_CODE_STATIC

    def test_select_lane_empty_string_falls_back(self):
        flow_card = {"vulnerability_class": ""}
        assert select_lane(flow_card) == LANE_CODE_STATIC

    def test_select_lane_missing_key_falls_back(self):
        flow_card = {}  # No vulnerability_class key
        assert select_lane(flow_card) == LANE_CODE_STATIC
