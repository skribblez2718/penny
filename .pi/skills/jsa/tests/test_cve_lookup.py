"""
Tests for cve_lookup.py and npm_name_map.py.

Uses unittest.mock.patch to mock urllib calls — no network access needed.
All test classes use stdlib only (no responses/httpx dependency).
"""

import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Ensure scripts directory is importable
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from cve_lookup import (
    OSVClient,
    VulnLookupClient,
    _compute_since_date,
    lookup_cves,
)
from npm_name_map import wappalyzer_to_npm, WAPPALYZER_TO_NPM


# ---------------------------------------------------------------------------
# npm_name_map Tests
# ---------------------------------------------------------------------------

class TestNpmNameMap:
    """Unit tests for Wappalyzer→npm name mapping."""

    def test_wappalyzer_to_npm_exact(self):
        result = wappalyzer_to_npm("jQuery")
        assert result is not None
        assert result["npm"] == "jquery"
        assert result["ecosystem"] == "npm"
        assert result["confidence"] == "CERTAIN"

    def test_wappalyzer_to_npm_react(self):
        result = wappalyzer_to_npm("React")
        assert result["npm"] == "react"
        assert result["confidence"] == "CERTAIN"

    def test_wappalyzer_to_npm_vue(self):
        result = wappalyzer_to_npm("Vue.js")
        assert result["npm"] == "vue"
        assert result["confidence"] == "CERTAIN"

    def test_wappalyzer_to_npm_angular(self):
        result = wappalyzer_to_npm("Angular")
        assert result["npm"] == "@angular/core"

    def test_wappalyzer_to_npm_lowercase_fallback(self):
        result = wappalyzer_to_npm("SomeUnknownLib")
        assert result is not None
        assert result["npm"] == "someunknownlib"
        assert result["confidence"] == "PROBABLE"

    def test_wappalyzer_to_npm_lowercase_with_spaces(self):
        result = wappalyzer_to_npm("Google Analytics")
        assert result["npm"] == "google-analytics"
        assert result["confidence"] == "PROBABLE"

    def test_wappalyzer_to_npm_scoped_package(self):
        result = wappalyzer_to_npm("@babel/runtime")
        assert result["npm"] == "@babel/runtime"
        assert result["confidence"] == "CERTAIN"

    def test_wappalyzer_to_npm_unmappable(self):
        result = wappalyzer_to_npm("X")
        assert result is None

    def test_wappalyzer_to_npm_empty_string(self):
        result = wappalyzer_to_npm("")
        assert result is None

    def test_wappalyzer_to_npm_all_known(self):
        for name in WAPPALYZER_TO_NPM:
            result = wappalyzer_to_npm(name)
            assert result is not None, f"{name} should be in WAPPALYZER_TO_NPM"
            assert result["confidence"] == "CERTAIN"


# ---------------------------------------------------------------------------
# OSVClient Tests
# ---------------------------------------------------------------------------

class TestOSVClient:
    """Unit tests for OSV.dev client (mocked HTTP)."""

    @patch("cve_lookup.urllib.request.urlopen")
    def test_query_success(self, mock_urlopen):
        mock_response = MagicMock()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_response.read.return_value = json.dumps({
            "vulns": [
                {
                    "id": "GHSA-test-1",
                    "summary": "Test vulnerability",
                    "published": "2024-01-15T00:00:00Z",
                    "modified": "2024-01-15T00:00:00Z",
                    "aliases": ["CVE-2024-0001"],
                    "severity": [{"type": "CVSS_V3", "score": "7.5"}],
                }
            ]
        }).encode()
        mock_urlopen.return_value = mock_response

        client = OSVClient()
        results = client.query("jquery", "npm", "1.9.0")

        assert len(results) == 1
        assert results[0]["cve_id"] == "CVE-2024-0001"
        assert results[0]["id"] == "GHSA-test-1"
        assert results[0]["summary"] == "Test vulnerability"
        assert results[0]["source"] == "osv.dev"
        assert results[0]["severity_score"] == 7.5

    @patch("cve_lookup.urllib.request.urlopen")
    def test_query_no_vulns(self, mock_urlopen):
        mock_response = MagicMock()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_response.read.return_value = json.dumps({"vulns": []}).encode()
        mock_urlopen.return_value = mock_response

        client = OSVClient()
        results = client.query("nonexistent-pkg", "npm")
        assert results == []

    @patch("cve_lookup.urllib.request.urlopen")
    def test_query_http_error(self, mock_urlopen):
        from urllib.error import HTTPError
        mock_urlopen.side_effect = HTTPError("http://x", 503, "Service Unavailable", {}, None)

        client = OSVClient()
        results = client.query("jquery", "npm", "1.9.0")
        assert results == []

    @patch("cve_lookup.urllib.request.urlopen")
    def test_query_timeout(self, mock_urlopen):
        from urllib.error import URLError
        mock_urlopen.side_effect = URLError("timeout")

        client = OSVClient()
        results = client.query("jquery", "npm", "1.9.0")
        assert results == []

    @patch("cve_lookup.urllib.request.urlopen")
    def test_query_invalid_json(self, mock_urlopen):
        mock_response = MagicMock()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_response.read.return_value = b"not json"
        mock_urlopen.return_value = mock_response

        client = OSVClient()
        results = client.query("jquery", "npm", "1.9.0")
        assert results == []


# ---------------------------------------------------------------------------
# VulnLookupClient Tests
# ---------------------------------------------------------------------------

class TestVulnLookupClient:
    """Unit tests for Vulnerability-Lookup client (mocked HTTP)."""

    @patch("cve_lookup.urllib.request.urlopen")
    def test_query_success(self, mock_urlopen):
        # VL returns a LIST with a wrapper dict
        mock_response = MagicMock()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        wrapper = {
            "results": {
                "cvelistv5": [
                    [
                        "CVE-2024-0001",
                        {
                            "cveMetadata": {"cveId": "CVE-2024-0001", "datePublished": "2024-01-15T00:00:00.000Z"},
                            "containers": {
                                "cna": {
                                    "descriptions": [{"lang": "en", "value": "Test CVE"}],
                                    "metrics": [{"cvssV3_1": {"baseScore": 8.0}}],
                                }
                            },
                        },
                    ]
                ]
            },
            "total_count": 1,
        }
        mock_response.read.return_value = json.dumps([wrapper]).encode()
        mock_urlopen.return_value = mock_response

        client = VulnLookupClient()
        results = client.query("jquery", "2024-01-01")

        assert len(results) == 1
        assert results[0]["cve_id"] == "CVE-2024-0001"
        assert results[0]["summary"] == "Test CVE"
        assert results[0]["cvss_score"] == 8.0
        assert results[0]["source"] == "vuln-lookup"

    @patch("cve_lookup.urllib.request.urlopen")
    def test_query_no_results(self, mock_urlopen):
        mock_response = MagicMock()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_response.read.return_value = json.dumps([{"results": {"cvelistv5": []}, "total_count": 0}]).encode()
        mock_urlopen.return_value = mock_response

        client = VulnLookupClient()
        results = client.query("nonexistent-product")
        assert results == []

    @patch("cve_lookup.urllib.request.urlopen")
    def test_get_details(self, mock_urlopen):
        mock_response = MagicMock()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_response.read.return_value = json.dumps({
            "cveMetadata": {"cveId": "CVE-2024-0001"},
            "containers": {"cna": {"descriptions": [{"lang": "en", "value": "Detail"}]}},
        }).encode()
        mock_urlopen.return_value = mock_response

        client = VulnLookupClient()
        details = client.get_details("CVE-2024-0001")

        assert details is not None
        assert details["cveMetadata"]["cveId"] == "CVE-2024-0001"

    @patch("cve_lookup.urllib.request.urlopen")
    def test_query_error(self, mock_urlopen):
        from urllib.error import URLError
        mock_urlopen.side_effect = URLError("network error")

        client = VulnLookupClient()
        results = client.query("jquery", "2024-01-01")
        assert results == []


# ---------------------------------------------------------------------------
# Helper Tests
# ---------------------------------------------------------------------------

class TestHelpers:
    """Tests for module-level helper functions."""

    def test_compute_since_date(self):
        result = _compute_since_date(6)
        # Should be a YYYY-MM-DD string
        assert len(result) == 10
        assert result[4] == "-"
        assert result[7] == "-"
        # Parse and verify it's roughly 6 months ago
        parsed = datetime.strptime(result, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        delta = now - parsed
        # Should be between 175 and 185 days
        assert 170 <= delta.days <= 190

    def test_compute_since_date_zero(self):
        result = _compute_since_date(0)
        # With 0 months back, should be ~30 days back
        parsed = datetime.strptime(result, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        assert 0 <= (now - parsed).days <= 31


# ---------------------------------------------------------------------------
# Integration Tests (with mocked HTTP)
# ---------------------------------------------------------------------------

class TestLookupCvesIntegration:
    """Integration tests for the lookup_cves convenience function."""

    @patch("cve_lookup.urllib.request.urlopen")
    def test_deduplication_across_sources(self, mock_urlopen):
        # Both sources return the same CVE. Use recent dates that are
        # within the months_back=12 window from now (2026).
        osv_data = {
            "vulns": [{
                "id": "GHSA-dup",
                "summary": "Duplicated CVE",
                "published": "2026-01-15T00:00:00Z",
                "aliases": ["CVE-2025-0001"],
                "severity": [],
            }]
        }
        vl_data = [{
            "results": {
                "cvelistv5": [[
                    "CVE-2025-0001",
                    {
                        "cveMetadata": {"cveId": "CVE-2025-0001", "datePublished": "2026-01-15T00:00:00.000Z"},
                        "containers": {"cna": {"descriptions": [{"lang": "en", "value": "Dup"}], "metrics": []}},
                    }
                ]]
            },
            "total_count": 1,
        }]

        responses = [osv_data, vl_data]
        call_idx = [0]

        def make_response(*args, **kwargs):
            r = MagicMock()
            r.__enter__ = MagicMock(return_value=r)
            r.__exit__ = MagicMock(return_value=False)
            r.read.return_value = json.dumps(responses[call_idx[0]]).encode()
            call_idx[0] += 1
            return r

        mock_urlopen.side_effect = make_response

        results = lookup_cves({"jQuery": "1.9.0"}, wappalyzer_to_npm, months_back=12)

        # CVE-2025-0001 should appear only once
        cve_ids = [c["cve_id"] for c in results]
        assert cve_ids.count("CVE-2025-0001") == 1

    @patch("cve_lookup.urllib.request.urlopen")
    def test_date_filter_excludes_old(self, mock_urlopen):
        # CVE from 2020 should be excluded with months_back=6
        osv_data = {
            "vulns": [{
                "id": "GHSA-old",
                "summary": "Old CVE",
                "published": "2020-01-15T00:00:00Z",
                "aliases": ["CVE-2020-9999"],
                "severity": [],
            }]
        }
        mock_response = MagicMock()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_response.read.return_value = json.dumps(osv_data).encode()
        mock_urlopen.return_value = mock_response

        results = lookup_cves({"jQuery": "1.9.0"}, wappalyzer_to_npm, months_back=6)
        # 2020-01-15 is way more than 6 months ago from now (2026)
        assert results == []

    def test_skip_no_version(self):
        results = lookup_cves({"jQuery": ""}, wappalyzer_to_npm, months_back=6)
        assert results == []

    def test_skip_unmappable(self):
        # "X" is unmappable (too short)
        results = lookup_cves({"X": "1.0.0"}, wappalyzer_to_npm, months_back=6)
        assert results == []

    def test_empty_input(self):
        results = lookup_cves({}, wappalyzer_to_npm, months_back=6)
        assert results == []

    @patch("cve_lookup.urllib.request.urlopen")
    def test_default_includes_old_cves(self, mock_urlopen):
        """Default behavior: no date filter. Old CVEs (from 2019-2020) are included
        as ranking signals, not excluded. This is critical for bug bounty work
        where old libraries with known CVEs are common targets."""
        osv_data = {
            "vulns": [{
                "id": "GHSA-old",
                "summary": "XSS in old jQuery",
                "published": "2019-04-26T00:00:00Z",
                "aliases": ["CVE-2019-11358"],
                "severity": [],
            }]
        }
        mock_response = MagicMock()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_response.read.return_value = json.dumps(osv_data).encode()
        mock_urlopen.return_value = mock_response

        # Default (no months_back specified) — old CVE should be INCLUDED
        results = lookup_cves({"jQuery": "1.9.0"}, wappalyzer_to_npm)
        assert len(results) == 1
        assert results[0]["cve_id"] == "CVE-2019-11358"
        # age_days should be computed
        assert results[0]["age_days"] is not None
        assert results[0]["age_days"] > 2000  # 2019 to 2026 is ~7 years
