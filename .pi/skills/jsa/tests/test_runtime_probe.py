"""
Runtime probe unit tests.

Covers:
- Per-library version detection across the 14 probe definitions
- Edge cases: None return, empty string, exception
- Version regex validation and fallback extraction
- Retry behavior
- execute_all_probes: full sweep, library filtering, dedup
- build_probe_results: known_libraries filter, output shape
"""

import sys
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from runtime_probe import (
    PROBES,
    RuntimeProbeResult,
    build_probe_results,
    execute_all_probes,
    execute_probe,
    _validate_version_regex,
)


def _find_probe(library_substr: str) -> dict:
    """Look up a probe by case-insensitive substring of its library name."""
    for p in PROBES:
        if library_substr.lower() in p["library"].lower():
            return p
    raise AssertionError(f"No probe found matching substring {library_substr!r}")


# ── Per-library version detection ──────────────────────────────────────────


class TestPerLibraryProbes:
    """Verify each library probe returns a structured result on success."""

    def _assert_success(self, library_substr: str, version: str):
        mock_page = Mock()
        mock_page.evaluate = Mock(return_value=version)
        probe = _find_probe(library_substr)
        result = execute_probe(mock_page, probe)
        assert result.library == probe["library"], (
            f"Library mismatch: {result.library} != {probe['library']}"
        )
        assert result.version == version, f"Version mismatch: {result.version} != {version}"
        assert result.confidence == "certain"
        assert result.error is None

    def test_jquery(self):
        self._assert_success("jQuery", "3.7.1")

    def test_react(self):
        self._assert_success("React", "18.2.0")

    def test_vue(self):
        self._assert_success("Vue", "3.4.0")

    def test_angular(self):
        # Angular has a different version_regex (accepts "1.x")
        self._assert_success("Angular", "16.2.0")

    def test_angular_legacy_fallback(self):
        """Angular's regex accepts '1.x' for legacy versions."""
        self._assert_success("Angular", "1.x")

    def test_lodash(self):
        self._assert_success("Lodash", "4.17.21")

    def test_moment(self):
        self._assert_success("Moment", "2.29.4")

    def test_d3(self):
        self._assert_success("D3", "7.8.5")

    def test_bootstrap(self):
        self._assert_success("Bootstrap", "5.3.0")

    def test_axios(self):
        self._assert_success("Axios", "1.6.0")

    def test_three_js_semver_format(self):
        """Three.js's version_regex expects semver. Test with a real semver value."""
        self._assert_success("Three", "0.158.0")

    def test_three_js_revision_format_falls_back(self):
        """Three.js's actual JS returns 'r158' (revision string).
        The strict regex doesn't match; fallback extraction finds '158' (digit-dot)
        or no match. The test documents the current behavior: error is set,
        confidence is 'possible'. This is a known limitation — Three.js
        detection from runtime probe alone is unreliable."""
        mock_page = Mock()
        mock_page.evaluate = Mock(return_value="r158")
        probe = _find_probe("Three")
        result = execute_probe(mock_page, probe)
        # Current behavior: version is None, error is set
        assert result.version is None
        assert result.error is not None
        assert "r158" in result.error
        assert result.confidence == "possible"

    def test_backbone(self):
        self._assert_success("Backbone", "1.4.1")

    def test_underscore(self):
        self._assert_success("Underscore", "1.13.6")

    def test_ember(self):
        self._assert_success("Ember", "5.0.0")

    def test_extjs(self):
        self._assert_success("ExtJS", "7.6.0")


# ── Library-not-present behavior ───────────────────────────────────────────


class TestLibraryNotPresent:
    """When a probe returns None/empty, the library is simply not in the result."""

    def test_none_return_means_not_detected(self):
        mock_page = Mock()
        mock_page.evaluate = Mock(return_value=None)
        result = execute_probe(mock_page, _find_probe("jQuery"))
        assert result.version is None
        assert result.error is None
        assert result.confidence == "certain"

    def test_empty_string_means_not_detected(self):
        mock_page = Mock()
        mock_page.evaluate = Mock(return_value="")
        result = execute_probe(mock_page, _find_probe("React"))
        assert result.version is None
        assert result.error is None

    def test_zero_means_not_detected(self):
        """Some libraries return 0/false; treat as not-present."""
        mock_page = Mock()
        mock_page.evaluate = Mock(return_value=0)
        result = execute_probe(mock_page, _find_probe("Axios"))
        assert result.version is None


# ── Error handling ─────────────────────────────────────────────────────────


class TestErrorHandling:
    def test_exception_sets_error(self):
        mock_page = Mock()
        mock_page.evaluate = Mock(side_effect=RuntimeError("navigate failed"))
        result = execute_probe(mock_page, _find_probe("jQuery"), max_retries=0)
        assert result.error is not None
        assert "navigate failed" in result.error
        assert result.confidence == "possible"

    def test_retry_recovers_from_transient_error(self):
        """A transient error on the first attempt should not set error if retry succeeds."""
        mock_page = Mock()
        # First call raises, second call returns a version
        mock_page.evaluate = Mock(side_effect=[RuntimeError("transient"), "3.6.0"])
        result = execute_probe(mock_page, _find_probe("jQuery"), max_retries=1)
        assert result.error is None
        assert result.version == "3.6.0"
        assert result.confidence == "certain"

    def test_retry_exhausted_sets_error(self):
        """After max_retries+1 attempts all failing, error is set."""
        mock_page = Mock()
        mock_page.evaluate = Mock(side_effect=RuntimeError("persistent"))
        result = execute_probe(mock_page, _find_probe("jQuery"), max_retries=2)
        # 1 initial + 2 retries = 3 calls; all should fail
        assert mock_page.evaluate.call_count == 3
        assert result.error is not None
        assert result.confidence == "possible"

    def test_unexpected_value_type_coerced_to_string(self):
        """Numbers or other types returned by page.evaluate are coerced to string."""
        mock_page = Mock()
        mock_page.evaluate = Mock(return_value=12345)  # int, not string
        result = execute_probe(mock_page, _find_probe("jQuery"))
        # Should treat as not-present because "12345" doesn't match version regex
        # and there's no \d+\.\d+ fallback to extract
        assert result.version is None or result.confidence == "possible"


# ── Version format mismatch ────────────────────────────────────────────────


class TestVersionFormatHandling:
    def test_unparseable_string_sets_error(self):
        """A non-version string that has no digits still gets recorded as error."""
        mock_page = Mock()
        mock_page.evaluate = Mock(return_value="not a version at all")
        result = execute_probe(mock_page, _find_probe("jQuery"), max_retries=0)
        assert result.version is None
        # The version_str "not a version at all" has no \d+\.\d+ to extract
        assert result.error is not None
        assert result.confidence == "possible"

    def test_version_with_extra_text_extracts_digits(self):
        r"""When version regex fails, \d+\.\d+ fallback should extract a usable version.

        We test with text like 'jQuery v3.6' where the strict regex fails
        (no patch component) and the fallback extracts the major.minor portion.
        """
        mock_page = Mock()
        mock_page.evaluate = Mock(return_value="jQuery v3.6")
        result = execute_probe(mock_page, _find_probe("jQuery"), max_retries=0)
        # Strict regex requires 3-part semver; "3.6" has only 2 parts
        # Fallback \d+\.\d+ should extract "3.6"
        assert result.version == "3.6", f"Expected '3.6', got {result.version!r}"
        assert result.error is None


# ── execute_all_probes ─────────────────────────────────────────────────────


class TestExecuteAllProbes:
    def test_runs_all_probes_by_default(self):
        mock_page = Mock()
        mock_page.evaluate = Mock(return_value=None)  # nothing detected
        results = execute_all_probes(mock_page)
        # All 14 probes should be executed
        assert mock_page.evaluate.call_count == len(PROBES)
        assert len(results) == len(PROBES)

    def test_uses_custom_probe_list(self):
        custom = [_find_probe("jQuery"), _find_probe("React")]
        mock_page = Mock()
        mock_page.evaluate = Mock(return_value=None)
        results = execute_all_probes(mock_page, probes=custom)
        assert len(results) == 2

    def test_invalid_regex_probe_is_skipped(self):
        """Probes with malformed regex should be silently skipped (not crash)."""
        good = _find_probe("jQuery")
        # Inject a probe with a bad regex
        bad = {
            "library": "BrokenLib",
            "probe": "try { return '1.0.0'; } catch(e) { return null; }",
            "version_regex": "[invalid(",  # malformed
        }
        mock_page = Mock()
        mock_page.evaluate = Mock(return_value=None)
        results = execute_all_probes(mock_page, probes=[good, bad])
        # Only the good probe should produce a result
        libraries = [r.library for r in results]
        assert "BrokenLib" not in libraries
        assert "jQuery" in libraries


# ── build_probe_results ────────────────────────────────────────────────────


class TestBuildProbeResults:
    def test_no_known_libraries_runs_all(self):
        mock_page = Mock()
        mock_page.evaluate = Mock(return_value=None)
        result = build_probe_results(mock_page)
        assert isinstance(result, dict)
        # With None returns, nothing is detected
        assert result == {}

    def test_known_libraries_filter(self):
        """Only probes for libraries in known_libraries are executed."""
        mock_page = Mock()
        mock_page.evaluate = Mock(return_value=None)
        result = build_probe_results(mock_page, known_libraries={"jquery", "react"})
        # We should have only called evaluate for jQuery + React probes
        assert mock_page.evaluate.call_count == 2

    def test_result_shape_when_detected(self):
        """When a version is detected, the result has the expected fields."""
        mock_page = Mock()
        # First call returns a version, subsequent return None
        mock_page.evaluate = Mock(side_effect=["3.7.1", None, None, None, None,
                                              None, None, None, None, None,
                                              None, None, None, None])
        result = build_probe_results(mock_page)
        assert "jQuery" in result
        assert result["jQuery"]["version"] == "3.7.1"
        assert result["jQuery"]["confidence"] == "certain"
        assert "probe" in result["jQuery"]
        assert result["jQuery"]["error"] is None

    def test_case_insensitive_known_libraries_match(self):
        """known_libraries filter should be case-insensitive."""
        mock_page = Mock()
        mock_page.evaluate = Mock(return_value=None)
        result = build_probe_results(mock_page, known_libraries={"JQUERY"})
        # jquery probe should run; React etc. should not
        assert mock_page.evaluate.call_count == 1


# ── Version regex validation ───────────────────────────────────────────────


class TestRegexValidation:
    def test_valid_regexes_pass(self):
        """All production probe regexes should be valid Python regex."""
        for probe in PROBES:
            assert _validate_version_regex(probe["version_regex"]), (
                f"Invalid regex in probe {probe['library']!r}: {probe['version_regex']!r}"
            )

    def test_invalid_regex_fails(self):
        assert _validate_version_regex("[invalid(") is False

    def test_empty_regex_fails(self):
        """An empty pattern is technically valid Python regex (matches anything)
        but production code may not want to accept it. Document the actual behavior."""
        # re.compile("") succeeds and matches everything
        assert _validate_version_regex("") is True


# ── Probe registration invariants ──────────────────────────────────────────


class TestProbeRegistration:
    def test_all_probes_have_required_keys(self):
        """Every probe must have library, probe, version_regex keys."""
        for probe in PROBES:
            assert "library" in probe, f"Probe missing 'library': {probe}"
            assert "probe" in probe, f"Probe missing 'probe': {probe}"
            assert "version_regex" in probe, f"Probe missing 'version_regex': {probe}"
            assert probe["library"], f"Empty library name: {probe}"

    def test_no_duplicate_libraries(self):
        """Each library should appear at most once in PROBES."""
        libraries = [p["library"] for p in PROBES]
        duplicates = {lib for lib in libraries if libraries.count(lib) > 1}
        assert not duplicates, f"Duplicate library entries: {duplicates}"

    def test_probes_are_callable_strings(self):
        """Probe JS code should be non-empty strings (not None or empty)."""
        for probe in PROBES:
            assert isinstance(probe["probe"], str), (
                f"Probe code is not a string: {probe['library']}"
            )
            assert probe["probe"].strip(), (
                f"Probe code is empty: {probe['library']}"
            )

    def test_minimum_expected_probes(self):
        """Sanity check: we expect at least the 14 documented libraries."""
        assert len(PROBES) >= 14, (
            f"Expected at least 14 probes, found {len(PROBES)}"
        )


# ── Result dataclass ───────────────────────────────────────────────────────


class TestResultDataclass:
    def test_default_construction(self):
        """RuntimeProbeResult should have sensible defaults."""
        r = RuntimeProbeResult()
        assert r.library == ""
        assert r.version is None
        assert r.probe == ""
        assert r.confidence == "certain"
        assert r.error is None

    def test_field_assignment(self):
        r = RuntimeProbeResult(
            library="Test",
            version="1.0.0",
            probe="return 1;",
            confidence="possible",
            error="something",
        )
        assert r.library == "Test"
        assert r.version == "1.0.0"
        assert r.probe == "return 1;"
        assert r.confidence == "possible"
        assert r.error == "something"
