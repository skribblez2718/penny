"""Unit tests for scanner_dedup.py."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from scanner_dedup import (
    normalize_rule_id,
    fingerprint_match,
    findings_equivalent,
    merge_scanner_findings,
    dedup_stats,
)


class TestNormalizeRuleId:
    def test_normalize_rule_id_known(self):
        assert normalize_rule_id("js/xss-through-dom") == "dom_xss"

    def test_normalize_rule_id_unknown(self):
        assert normalize_rule_id("js/custom-rule") == "js/custom-rule"


class TestFingerprintMatch:
    def test_fingerprint_match_same(self):
        fa = {"source": "semgrep", "fingerprint": "abc123", "file": "/path/to/app.js"}
        fb = {"source": "semgrep", "fingerprint": "abc123", "file": "/path/to/app.js"}
        assert fingerprint_match(fa, fb) is True

    def test_fingerprint_match_different(self):
        fa = {"source": "semgrep", "fingerprint": "abc123", "file": "/path/to/app.js"}
        fb = {"source": "semgrep", "fingerprint": "xyz999", "file": "/path/to/app.js"}
        assert fingerprint_match(fa, fb) is False

    def test_fingerprint_match_cross_scanner(self):
        fa = {"source": "semgrep", "fingerprint": "abc123", "file": "/path/to/app.js"}
        fb = {"source": "ast_trace", "fingerprint": "abc123", "file": "/path/to/app.js"}
        assert fingerprint_match(fa, fb) is True


class TestFindingsEquivalent:
    def test_findings_equivalent_same_line(self):
        fa = {"rule_id": "js/xss-through-dom", "file": "app.js", "line": 10}
        fb = {"rule_id": "dom_xss", "file": "app.js", "line": 12}
        assert findings_equivalent(fa, fb) is True

    def test_findings_equivalent_different_files(self):
        fa = {"rule_id": "js/xss-through-dom", "file": "app.js", "line": 10}
        fb = {"rule_id": "dom_xss", "file": "utils.js", "line": 10}
        assert findings_equivalent(fa, fb) is False

    def test_findings_equivalent_different_vulns(self):
        fa = {"rule_id": "js/xss-through-dom", "file": "app.js", "line": 10}
        fb = {"rule_id": "js/sql-injection", "file": "app.js", "line": 10}
        assert findings_equivalent(fa, fb) is False


class TestMergeScannerFindings:
    def test_merge_single_finding(self):
        sast = [
            {"rule_id": "dom_xss", "file": "app.js", "line": 10, "source": "semgrep", "message": "xss"},
        ]
        result = merge_scanner_findings(sast)
        assert len(result) == 1
        assert result[0]["vuln_class"] == "dom_xss"

    def test_merge_distinct_findings(self):
        sast = [
            {"rule_id": "js/xss-through-dom", "file": "app.js", "line": 10, "source": "semgrep", "message": "xss"},
        ]
        result = merge_scanner_findings(sast)
        assert len(result) == 1
        assert result[0]["vuln_class"] == "dom_xss"

    def test_merge_overlapping(self):
        sast = [
            {"rule_id": "dom_xss", "file": "app.js", "line": 10, "source": "semgrep", "message": "dom xss found"},
            {"rule_id": "js/xss-through-dom", "file": "app.js", "line": 12, "source": "semgrep", "message": "xss"},
        ]
        result = merge_scanner_findings(sast)
        assert len(result) == 1
        assert result[0].get("source") == "semgrep"

    def test_merge_fingerprint_dedup(self):
        sast = [
            {"rule_id": "js/xss-through-dom", "file": "app.js", "line": 10,
             "source": "semgrep", "fingerprint": "fp1", "message": "xss"},
            {"rule_id": "js/xss-through-dom", "file": "app.js", "line": 11,
             "source": "semgrep", "fingerprint": "fp1", "message": "xss duplicate"},
        ]
        result = merge_scanner_findings(sast)
        # One should be dropped due to identical fingerprint+file
        assert len(result) == 1


class TestDedupStats:
    def test_dedup_stats(self):
        stats = dedup_stats(8, 6)
        assert stats["input_sast"] == 8
        assert stats["output"] == 6
        assert stats["dedup_rate"] == 0.25


if __name__ == "__main__":
    import pytest

    pytest.main([__file__, "-v"])
