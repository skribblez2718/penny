"""Tests for the page-informed, signal-gated INVESTIGATE candidate-class
selection (``jsa_domain._candidate_classes`` + helpers).

The regression these guard: INVESTIGATE coverage must NOT be bounded by what SAST
flags. Classes SAST is blind to (reflected_xss, csti, dom_data_manipulation,
link_manipulation, request_override, http_header_injection) must still be
investigated when the target's pages/JS imply that surface — via signals + a core
floor — while a signal-less run stays lean (no all-22 blind fan).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from fsm import JSAState  # noqa: E402
import jsa_domain as jd  # noqa: E402


def _state(**meta):
    st = JSAState()
    st.metadata = dict(meta)
    return st


class TestCandidateClasses:
    def test_ginandjuice_signals_cover_the_previously_missed_clusters(self):
        """The classes our earlier run missed must now be selected from the same
        signals (SAST hits + dangerous patterns + page behavior + a vulnerable dep)."""
        st = _state(
            acquire_result={
                "total_js_files": 11, "html_files": 14,
                "pages_with_forms": 3, "pages_with_api_calls": 4, "endpoints_found": 7,
            },
            cve_research={"versions": {"AngularJS": "1.7.7", "React": "18.2.0"}},
        )
        st.module_cards = [object()] * 11
        st.flow_cards = [
            {"vulnerability_class": "prototype_pollution"},
            {"vulnerability_class": "dom_xss"},
            {"vulnerability_class": "xss"},   # generic SAST label -> dropped
            {"vulnerability_class": "cve"},   # not a catalogued analyzer -> dropped
        ]
        st.typed_store = {"dangerous_patterns": [
            {"suggested_vuln_classes": ["dom_xss", "open_redirect"]},
        ]}

        got = set(jd._candidate_classes(st))
        # every previously-missed client-side cluster is now covered
        assert {"reflected_xss", "csti", "dom_data_manipulation", "link_manipulation",
                "request_override", "http_header_injection"} <= got
        # dep exploitation classes for AngularJS are present
        assert {"csti", "dom_xss"} <= got
        # generic/non-catalogued labels are filtered out
        assert "xss" not in got and "cve" not in got
        # still bounded — signal-gated, not all 22
        assert len(got) <= 14

    def test_core_floor_applies_when_client_surface_present(self):
        """A target with HTML/JS but few explicit signals still gets the core floor."""
        st = _state(acquire_result={"total_js_files": 2, "html_files": 1})
        got = set(jd._candidate_classes(st))
        assert set(jd._CORE_FLOOR) <= got

    def test_no_client_surface_stays_lean(self):
        """No JS and no HTML -> no floor, no blind fan (empty candidate set)."""
        st = _state(acquire_result={"total_js_files": 0, "html_files": 0})
        assert jd._candidate_classes(st) == []

    def test_page_signals_are_gated(self):
        """API/XHR + form signals add their classes ONLY when present."""
        with_api = _state(acquire_result={"html_files": 1, "pages_with_api_calls": 2})
        assert {"http_header_injection", "request_override", "ssrf"} <= set(
            jd._page_signal_classes(with_api)
        )
        none = _state(acquire_result={"html_files": 1})
        assert jd._page_signal_classes(none) == set()

    def test_cve_exploitation_classes_map_detected_deps(self):
        st = _state(cve_research={"versions": {"jQuery": "1.9.0"}})
        assert "dom_xss" in jd._cve_exploitation_classes(st)
        st2 = _state(cve_research={"tech_stack": {"lodash": ["4.17.4"]}})
        assert "prototype_pollution" in jd._cve_exploitation_classes(st2)

    def test_all_selected_classes_are_known_analyzers(self):
        """Never dispatch a class without a references/<class>.md catalog."""
        import lane_router
        known = set(lane_router.get_all_analyzers())
        st = _state(
            acquire_result={"total_js_files": 5, "html_files": 3,
                            "pages_with_forms": 1, "pages_with_api_calls": 1},
            cve_research={"versions": {"AngularJS": "1.7.7"}},
        )
        st.module_cards = [object()] * 5
        assert set(jd._candidate_classes(st)) <= known
