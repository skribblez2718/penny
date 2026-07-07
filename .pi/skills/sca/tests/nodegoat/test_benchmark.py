"""
Unit tests for the NodeGoat benchmark harness (Phase 11).

These tests prove ``compute_benchmark_metrics`` computes precision/recall/F1
correctly using SYNTHETIC (non-NodeGoat) fixtures. They are fast-lane tests:
pure computation, no real NodeGoat clone, no network, no subprocess. The
harness's correctness is therefore fully verified independent of whether real
NodeGoat ground-truth data ever gets populated.

The separate opt-in/local-only integration test that WOULD run the real sca
pipeline against a real NodeGoat clone lives in ``test_nodegoat_integration.py``
and skips gracefully when no clone is present.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

# Make the sibling benchmark.py importable regardless of collection root.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from benchmark import (  # noqa: E402
    GROUND_TRUTH_ENTRY_FIELDS,
    compute_benchmark_metrics,
    load_ground_truth,
)


# ── Synthetic fixtures (NOT NodeGoat data) ───────────────────────────────


def _gt(file, line, vuln_class="injection", severity="high", cvss=None):
    return {
        "app_path": "/synthetic/app",
        "vuln_class": vuln_class,
        "file": file,
        "line": line,
        "severity": severity,
        "cvss_4_0_vector": cvss,
    }


def _finding(file, line, vuln_class=None):
    d = {"file": file, "line": line, "tool": "synthetic"}
    if vuln_class is not None:
        d["vuln_class"] = vuln_class
    return d


# ── Perfect / partial / disjoint matching ────────────────────────────────


class TestMatchingCounts:
    def test_perfect_match_all_true_positives(self):
        gt = [_gt("app/a.js", 10), _gt("app/b.js", 20)]
        found = [_finding("app/a.js", 10), _finding("app/b.js", 20)]
        m = compute_benchmark_metrics(gt, found)
        assert m["true_positives"] == 2
        assert m["false_positives"] == 0
        assert m["false_negatives"] == 0
        assert m["precision"] == 1.0
        assert m["recall"] == 1.0
        assert m["f1"] == 1.0

    def test_partial_recall_missing_finding_is_false_negative(self):
        gt = [_gt("app/a.js", 10), _gt("app/b.js", 20)]
        found = [_finding("app/a.js", 10)]  # missed b.js
        m = compute_benchmark_metrics(gt, found)
        assert m["true_positives"] == 1
        assert m["false_positives"] == 0
        assert m["false_negatives"] == 1
        assert m["precision"] == 1.0
        assert m["recall"] == 0.5
        assert m["f1"] == pytest.approx(2 / 3, abs=1e-6)

    def test_extra_finding_is_false_positive(self):
        gt = [_gt("app/a.js", 10)]
        found = [_finding("app/a.js", 10), _finding("app/noise.js", 99)]
        m = compute_benchmark_metrics(gt, found)
        assert m["true_positives"] == 1
        assert m["false_positives"] == 1
        assert m["false_negatives"] == 0
        assert m["precision"] == 0.5
        assert m["recall"] == 1.0
        assert m["f1"] == pytest.approx(2 / 3, abs=1e-6)

    def test_completely_disjoint_zero_tp(self):
        gt = [_gt("app/a.js", 10)]
        found = [_finding("app/z.js", 1)]
        m = compute_benchmark_metrics(gt, found)
        assert m["true_positives"] == 0
        assert m["false_positives"] == 1
        assert m["false_negatives"] == 1
        assert m["precision"] == 0.0
        assert m["recall"] == 0.0
        assert m["f1"] == 0.0

    def test_known_precision_recall_f1_values(self):
        # 3 TP, 1 FP, 2 FN -> P=0.75, R=0.6, F1=0.666667
        gt = [
            _gt("a.js", 1), _gt("b.js", 2), _gt("c.js", 3),
            _gt("d.js", 4), _gt("e.js", 5),
        ]
        found = [
            _finding("a.js", 1), _finding("b.js", 2), _finding("c.js", 3),
            _finding("noise.js", 100),
        ]
        m = compute_benchmark_metrics(gt, found)
        assert m["true_positives"] == 3
        assert m["false_positives"] == 1
        assert m["false_negatives"] == 2
        assert m["precision"] == 0.75
        assert m["recall"] == 0.6
        assert m["f1"] == pytest.approx(2 * 0.75 * 0.6 / (0.75 + 0.6), abs=1e-6)


# ── Edge cases: empty inputs, no divide-by-zero ──────────────────────────


class TestEdgeCases:
    def test_empty_ground_truth_and_findings(self):
        m = compute_benchmark_metrics([], [])
        assert m["true_positives"] == 0
        assert m["false_positives"] == 0
        assert m["false_negatives"] == 0
        assert m["precision"] == 0.0
        assert m["recall"] == 0.0
        assert m["f1"] == 0.0

    def test_empty_ground_truth_findings_all_false_positive(self):
        m = compute_benchmark_metrics([], [_finding("a.js", 1)])
        assert m["false_positives"] == 1
        assert m["recall"] == 0.0  # no divide-by-zero on empty ground truth
        assert m["precision"] == 0.0

    def test_empty_findings_all_false_negative(self):
        m = compute_benchmark_metrics([_gt("a.js", 1)], [])
        assert m["false_negatives"] == 1
        assert m["precision"] == 0.0  # no divide-by-zero on empty findings
        assert m["recall"] == 0.0

    def test_none_inputs_do_not_raise(self):
        m = compute_benchmark_metrics(None, None)  # type: ignore[arg-type]
        assert m["ground_truth_count"] == 0
        assert m["discovered_count"] == 0


# ── Matching semantics ───────────────────────────────────────────────────


class TestMatchingSemantics:
    def test_path_suffix_match_absolute_vs_relative(self):
        gt = [_gt("app/routes/x.js", 42)]
        found = [_finding("/tmp/clone/app/routes/x.js", 42)]
        m = compute_benchmark_metrics(gt, found)
        assert m["true_positives"] == 1

    def test_line_tolerance_off_by_default(self):
        gt = [_gt("a.js", 10)]
        found = [_finding("a.js", 12)]
        assert compute_benchmark_metrics(gt, found)["true_positives"] == 0
        assert compute_benchmark_metrics(
            gt, found, line_tolerance=2
        )["true_positives"] == 1

    def test_vuln_class_gate_when_enabled(self):
        gt = [_gt("a.js", 10, vuln_class="ssrf")]
        found = [_finding("a.js", 10, vuln_class="xss")]
        # off by default: still matches on file+line
        assert compute_benchmark_metrics(gt, found)["true_positives"] == 1
        # enabled: mismatched class blocks the match
        assert compute_benchmark_metrics(
            gt, found, match_vuln_class=True
        )["true_positives"] == 0

    def test_one_to_one_matching_no_double_count(self):
        # Two ground-truth entries at the same location, one finding: only one
        # can be a true positive; the other is a false negative.
        gt = [_gt("a.js", 10), _gt("a.js", 10)]
        found = [_finding("a.js", 10)]
        m = compute_benchmark_metrics(gt, found)
        assert m["true_positives"] == 1
        assert m["false_negatives"] == 1
        assert m["false_positives"] == 0

    def test_missing_line_does_not_match(self):
        gt = [_gt("a.js", 10)]
        found = [{"file": "a.js", "tool": "synthetic"}]  # no line
        assert compute_benchmark_metrics(gt, found)["true_positives"] == 0

    def test_result_is_deterministic(self):
        gt = [_gt("a.js", 1), _gt("b.js", 2)]
        found = [_finding("b.js", 2), _finding("a.js", 1)]
        first = compute_benchmark_metrics(gt, found)
        second = compute_benchmark_metrics(gt, found)
        assert first == second


# ── Ground-truth loader + on-disk template ───────────────────────────────


class TestGroundTruthLoader:
    def test_missing_file_returns_empty(self, tmp_path):
        assert load_ground_truth(tmp_path / "nope.json") == []

    def test_malformed_file_returns_empty(self, tmp_path):
        p = tmp_path / "bad.json"
        p.write_text("{ not json", encoding="utf-8")
        assert load_ground_truth(p) == []

    def test_reads_entries_list(self, tmp_path):
        p = tmp_path / "gt.json"
        p.write_text(json.dumps({"schema": 1, "entries": [_gt("a.js", 1)]}),
                     encoding="utf-8")
        loaded = load_ground_truth(p)
        assert len(loaded) == 1
        assert loaded[0]["file"] == "a.js"

    def test_shipped_template_is_honest_empty(self):
        # The committed ground-truth.json must be an honest EMPTY template:
        # no fabricated NodeGoat locations. If someone genuinely populates it
        # later, this test documents that entries must still parse cleanly.
        shipped = Path(__file__).resolve().parent / "ground-truth.json"
        entries = load_ground_truth(shipped)
        assert isinstance(entries, list)
        # Every present entry (if any are ever added) must carry the schema.
        for e in entries:
            for fld in GROUND_TRUTH_ENTRY_FIELDS:
                assert fld in e, f"ground-truth entry missing field {fld!r}"
