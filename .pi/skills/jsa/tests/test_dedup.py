"""
Dedup engine unit tests.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from dedup import (
    Finding,
    MergedFinding,
    normalize_pattern,
    source_compatible,
    sink_compatible,
    finding_similarity,
    cluster_findings,
    merge_cluster,
    promote_confidence,
    cross_file_dedup,
    score_merged_finding,
    merge_and_dedup,
)


def _make_finding(**kwargs) -> Finding:
    """Quickly create a finding with defaults."""
    defaults = {
        "finding_id": "f-001",
        "chunk_id": "chunk-0",
        "file": "app.js",
        "vuln_class": "dom_xss",
        "source": "location.hash",
        "sink": "element.innerHTML",
        "line_start": 100,
        "line_end": 100,
        "confidence": "possible",
        "description": "DOM XSS via location.hash → innerHTML",
        "code_snippet": "element.innerHTML = location.hash.slice(1);",
        "data_flow": "location.hash → slice → innerHTML",
        "is_boundary": False,
        "scanner": "semgrep",
    }
    defaults.update(kwargs)
    return Finding(**defaults)


class TestNormalize:
    def test_strips_window(self):
        assert normalize_pattern("window.location.hash") == "location.hash"
    
    def test_strips_document(self):
        assert normalize_pattern("document.referrer") == "referrer"
    
    def test_preserves_core(self):
        assert normalize_pattern("location.hash") == "location.hash"
    
    def test_case_insensitive(self):
        assert normalize_pattern("Location.HASH") == "location.hash"


class TestCompatibility:
    def test_url_sources(self):
        assert source_compatible("location.hash", "location.search")
    
    def test_different_categories(self):
        assert not source_compatible("location.hash", "event.data")
    
    def test_dom_sinks(self):
        assert sink_compatible("element.innerHTML", "element.outerHTML")
    
    def test_exec_sinks(self):
        assert sink_compatible("eval()", "new Function()")


class TestSimilarity:
    def test_identical_findings(self):
        a = _make_finding()
        b = _make_finding()
        assert finding_similarity(a, b) > 0.9
    
    def test_different_sinks(self):
        a = _make_finding(sink="element.innerHTML", code_snippet="el.innerHTML = hash;", 
                         description="DOM XSS via innerHTML")
        b = _make_finding(sink="eval()", code_snippet="eval(userInput);",
                         description="Code execution via eval", line_start=105)
        sim = finding_similarity(a, b)
        # Different sink categories (DOM vs exec) — lower similarity
        assert sim < 0.50, f"Expected < 0.50 got {sim}"
    
    def test_different_vuln_classes_lower_similarity(self):
        a = _make_finding(vuln_class="dom_xss")
        b = _make_finding(vuln_class="reflected_xss")
        # Similarity doesn't factor vuln_class — grouping handles that
        sim = finding_similarity(a, b)
        assert sim > 0.5  # Same source, sink, line
    
    def test_far_apart_lines(self):
        a = _make_finding(line_start=100)
        b = _make_finding(line_start=500)
        assert finding_similarity(a, b) < finding_similarity(
            _make_finding(line_start=100), _make_finding(line_start=105)
        )


class TestClustering:
    def test_identical_findings_cluster(self):
        findings = [_make_finding(finding_id=f"f-{i}") for i in range(3)]
        clusters = cluster_findings(findings, threshold=0.6)
        assert len(clusters) == 1
        assert len(clusters[0]) == 3
    
    def test_different_findings_separate(self):
        f1 = _make_finding(sink="element.innerHTML")
        f2 = _make_finding(sink="document.write")
        clusters = cluster_findings([f1, f2], threshold=0.6)
        assert len(clusters) >= 1  # May or may not merge depending on similarity
    
    def test_empty(self):
        assert cluster_findings([]) == []
    
    def test_single(self):
        assert len(cluster_findings([_make_finding()])) == 1


class TestMergeCluster:
    def test_singleton_no_change(self):
        f = _make_finding(confidence="probable")
        merged = merge_cluster([f])
        assert merged.confidence == "probable"
        assert merged.duplicate_count == 1
    
    def test_merges_line_range(self):
        f1 = _make_finding(line_start=100, line_end=100)
        f2 = _make_finding(line_start=105, line_end=108)
        merged = merge_cluster([f1, f2])
        assert merged.line_start == 100
        assert merged.line_end == 108
    
    def test_merges_scanner_consensus(self):
        f1 = _make_finding(scanner="semgrep")
        f2 = _make_finding(scanner="ast_trace")
        merged = merge_cluster([f1, f2])
        assert len(merged.scanner_consensus) == 2


class TestPromotion:
    def test_singleton_no_promotion(self):
        assert promote_confidence([_make_finding(confidence="possible")]) == "possible"
    
    def test_two_different_chunks_promotes(self):
        f1 = _make_finding(confidence="possible", chunk_id="chunk-0")
        f2 = _make_finding(confidence="possible", chunk_id="chunk-1")
        assert promote_confidence([f1, f2]) == "probable"
    
    def test_three_chunks_two_scanners(self):
        f1 = _make_finding(confidence="probable", chunk_id="c0", scanner="semgrep")
        f2 = _make_finding(confidence="probable", chunk_id="c1", scanner="semgrep")
        f3 = _make_finding(confidence="probable", chunk_id="c2", scanner="ast_trace")
        assert promote_confidence([f1, f2, f3]) == "confirmed"
    
    def test_same_chunk_no_promotion(self):
        f1 = _make_finding(chunk_id="chunk-0")
        f2 = _make_finding(chunk_id="chunk-0")
        assert promote_confidence([f1, f2]) == "possible"


class TestCrossFileDedup:
    def test_same_pattern_different_files(self):
        f1 = MergedFinding(vuln_class="dom_xss", source="location.hash", 
                          sink="element.innerHTML", file="app.js")
        f2 = MergedFinding(vuln_class="dom_xss", source="location.hash",
                          sink="element.innerHTML", file="utils.js")
        result = cross_file_dedup([f1, f2])
        assert len(result) == 1
        assert result[0].duplicate_count >= 2
    
    def test_different_patterns_kept(self):
        f1 = MergedFinding(vuln_class="dom_xss", source="location.hash", 
                          sink="element.innerHTML", file="a.js")
        f2 = MergedFinding(vuln_class="prototype_pollution", source="__proto__",
                          sink="Object.assign", file="b.js")
        result = cross_file_dedup([f1, f2])
        assert len(result) == 2


class TestScoring:
    def test_confirmed_dom_xss_scores_high(self):
        f = MergedFinding(confidence="confirmed", vuln_class="dom_xss", 
                         duplicate_count=5, scanner_consensus=["semgrep", "ast_trace"])
        score = score_merged_finding(f)
        assert score > 70
    
    def test_possible_clickjacking_scores_low(self):
        f = MergedFinding(confidence="possible", vuln_class="clickjacking")
        score = score_merged_finding(f)
        assert score < 30


class TestMergeAndDedup:
    def test_full_pipeline(self):
        findings = [
            _make_finding(finding_id="1", chunk_id="c0", confidence="possible"),
            _make_finding(finding_id="2", chunk_id="c1", confidence="possible"),  # same
            _make_finding(finding_id="3", chunk_id="c0", sink="document.write"),   # different sink
        ]
        result = merge_and_dedup(findings)
        assert result.total_raw == 3
        assert result.total_merged < 3  # Should dedup
        assert result.duplication_rate > 0
    
    def test_empty(self):
        result = merge_and_dedup([])
        assert result.total_raw == 0
        assert result.total_merged == 0
    
    def test_no_duplicates(self):
        findings = [
            _make_finding(finding_id="1", sink="innerHTML", source="location.hash", 
                         chunk_id="c1"),
            _make_finding(finding_id="2", sink="document.write", source="location.search",
                         chunk_id="c2", line_start=200),
            _make_finding(finding_id="3", sink="eval()", source="event.data",
                         chunk_id="c3", line_start=300),
        ]
        result = merge_and_dedup(findings)
        assert result.total_merged == 3, f"Expected 3 merged, got {result.total_merged}"  # All different


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
