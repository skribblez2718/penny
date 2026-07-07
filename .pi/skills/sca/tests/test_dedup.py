"""
Unit tests for sca dedup.py (Phase 5) — deterministic finding deduplication.

Two-stage dedup:
  PRIMARY  exact match on (tool, rule_id, file, line) -> collapse to one,
           preferring the finding with more populated fields.
  SECONDARY for findings NOT sharing the primary key: textual similarity on
           `description` via stdlib difflib.SequenceMatcher(...).ratio(); if
           ratio >= threshold AND file matches AND |line delta| <= window
           (window = 5, INCLUSIVE), merge, keeping the higher-CONFIDENCE finding.

Determinism (no ML/embedding dependency) and the conservative-merge tradeoff
(0.85 threshold + file + line-window guard) are exercised here. Confidence and
severity remain independent throughout: merge selection uses CONFIDENCE, never
severity.

No network, no subprocess.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import dedup as dd  # noqa: E402
from dedup import deduplicate_findings  # noqa: E402
from normalize import NormalizedFinding  # noqa: E402


def _f(
    id,
    *,
    tool="semgrep",
    rule_id="rule.x",
    file="src/a.js",
    line=10,
    description="desc",
    confidence="medium",
    severity="ERROR",
    **extra,
):
    return NormalizedFinding(
        id=id,
        tool=tool,
        rule_id=rule_id,
        title=extra.get("title", "t"),
        description=description,
        file=file,
        line=line,
        severity=severity,
        confidence=confidence,
        evidence_basis=extra.get("evidence_basis", "inferred"),
        column=extra.get("column"),
        cwe_ids=list(extra.get("cwe_ids", [])),
        asvs_references=list(extra.get("asvs_references", [])),
    )


# ── Trivial / passthrough cases ──────────────────────────────────────────


class TestPassthrough:
    def test_empty_list(self):
        result, merges = deduplicate_findings([])
        assert result == []
        assert merges == {}

    def test_single_finding_unchanged(self):
        f = _f("F1")
        result, merges = deduplicate_findings([f])
        assert len(result) == 1
        assert result[0].id == "F1"
        assert merges == {"F1": []}

    def test_distinct_findings_not_merged(self):
        a = _f("A", rule_id="r1", line=1, description="alpha finding")
        b = _f("B", rule_id="r2", line=99, description="totally other thing")
        result, merges = deduplicate_findings([a, b])
        assert {x.id for x in result} == {"A", "B"}
        assert merges["A"] == []
        assert merges["B"] == []


# ── PRIMARY key dedup: exact (tool, rule_id, file, line) ──────────────────


class TestPrimaryKeyDedup:
    def test_exact_key_collapses_to_one(self):
        a = _f("A")
        b = _f("B")  # same tool/rule/file/line
        result, merges = deduplicate_findings([a, b])
        assert len(result) == 1
        survivor = result[0]
        merged_ids = merges[survivor.id]
        # exactly one of the two ids survived, the other was merged in
        assert {survivor.id, *merged_ids} == {"A", "B"}
        assert len(merged_ids) == 1

    def test_prefers_more_populated_finding(self):
        sparse = _f("SPARSE")
        rich = _f("RICH", cwe_ids=["CWE-79"], asvs_references=["V5.1.1"], column=4)
        result, merges = deduplicate_findings([sparse, rich])
        assert len(result) == 1
        assert result[0].id == "RICH"  # richer one survives
        assert merges["RICH"] == ["SPARSE"]

    def test_different_line_is_not_primary_key_match(self):
        a = _f("A", line=10, description="x")
        b = _f("B", line=20, description="y")  # far apart, dissimilar text
        result, _ = deduplicate_findings([a, b])
        assert len(result) == 2

    def test_different_tool_not_merged(self):
        a = _f("A", tool="semgrep")
        b = _f("B", tool="gitleaks", description="zzz unrelated")
        result, _ = deduplicate_findings([a, b])
        assert len(result) == 2


# ── COLUMN awareness (Carren regression fixes) ────────────────────────────


class TestColumnAwarePrimaryKey:
    """Fix (b): the PRIMARY exact-key must include ``column`` when BOTH compared
    findings carry a non-None column, so two genuinely-different secrets on the
    SAME (tool, rule_id, file, line) but different COLUMN do not silently
    collapse. When either column is None we fall back to the base
    (tool, rule_id, file, line) key (documented fallback).
    """

    def test_same_line_distinct_columns_not_collapsed_primary(self):
        # Same (tool, rule_id, file, line); distinct non-None columns; DIFFERENT
        # descriptions so the SECONDARY similarity path can never merge them.
        # This isolates the PRIMARY stage: it must NOT collapse them.
        a = _f("A", column=19, description="first distinct secret alpha")
        b = _f("B", column=42, description="a completely different message zzz")
        result, merges = deduplicate_findings([a, b])
        assert {x.id for x in result} == {"A", "B"}
        assert merges["A"] == []
        assert merges["B"] == []

    def test_same_line_same_column_still_collapses_primary(self):
        # Identical non-None column -> a true duplicate -> still collapses.
        a = _f("A", column=19)
        b = _f("B", column=19)
        result, _ = deduplicate_findings([a, b])
        assert len(result) == 1

    def test_none_column_falls_back_to_base_key(self):
        # Either column None -> fall back to (tool, rule_id, file, line) key ->
        # they still collapse (documented fallback, current behavior preserved).
        a = _f("A", column=None)
        b = _f("B", column=19)
        result, _ = deduplicate_findings([a, b])
        assert len(result) == 1


class TestSecretsSimilarityGuard:
    """Fix (a): two GENUINELY DIFFERENT secrets (e.g. two AWS keys) with the same
    static/boilerplate rule ``description`` but different COLUMN must NOT be
    merged by the SECONDARY similarity path. The description text is identical
    (ratio 1.0) by design for secret-detection rules, so the column difference
    is the only positional signal that they are distinct — never merge across it.
    """

    _SECRET_DESC = "Detected a hardcoded AWS Access Key. Rotate it immediately."

    def test_distinct_secrets_diff_column_not_similarity_merged(self):
        # Different lines within the similarity window, distinct non-None
        # columns, IDENTICAL boilerplate description (ratio == 1.0). On the old
        # code the similarity path merges these (the bug); it must NOT now.
        a = _f("A", tool="gitleaks", rule_id="aws-access-token", line=10,
               column=19, description=self._SECRET_DESC)
        b = _f("B", tool="gitleaks", rule_id="aws-access-token", line=12,
               column=44, description=self._SECRET_DESC)
        result, merges = deduplicate_findings([a, b])
        assert {x.id for x in result} == {"A", "B"}
        assert merges["A"] == []
        assert merges["B"] == []

    def test_same_line_distinct_columns_two_secrets_survive(self):
        # Same file/line/rule/tool, distinct columns, identical boilerplate:
        # the classic "two secrets a few columns apart" case. Both must survive
        # (neither primary nor similarity may collapse them).
        a = _f("A", tool="gitleaks", rule_id="aws-access-token", line=7,
               column=19, description=self._SECRET_DESC)
        b = _f("B", tool="gitleaks", rule_id="aws-access-token", line=7,
               column=55, description=self._SECRET_DESC)
        result, _ = deduplicate_findings([a, b])
        assert len(result) == 2

    def test_same_column_identical_desc_still_merges(self):
        # Guard must NOT over-block: a genuine re-run duplicate reports the SAME
        # column, so identical description + same column still merges normally.
        a = _f("A", tool="gitleaks", rule_id="aws-access-token", line=10,
               column=19, confidence="low", description=self._SECRET_DESC)
        b = _f("B", tool="gitleaks", rule_id="aws-access-token", line=12,
               column=19, confidence="high", description=self._SECRET_DESC)
        result, _ = deduplicate_findings([a, b])
        assert len(result) == 1


# ── SECONDARY similarity dedup ───────────────────────────────────────────


class TestSimilarityDedup:
    def test_high_similarity_same_file_close_line_merges(self):
        a = _f("A", rule_id="r1", line=10,
               description="Detected SQL injection via string concatenation")
        b = _f("B", rule_id="r2", line=12,
               description="Detected SQL injection via string concatenation!")
        result, merges = deduplicate_findings([a, b], similarity_threshold=0.85)
        assert len(result) == 1
        survivor = result[0]
        assert {survivor.id, *merges[survivor.id]} == {"A", "B"}

    def test_similarity_keeps_higher_confidence(self):
        low = _f("LOW", rule_id="r1", line=10, confidence="low",
                 description="Detected SQL injection via concatenation here")
        high = _f("HIGH", rule_id="r2", line=11, confidence="high",
                  description="Detected SQL injection via concatenation here.")
        result, merges = deduplicate_findings([low, high])
        assert len(result) == 1
        assert result[0].id == "HIGH"  # higher CONFIDENCE survives
        assert merges["HIGH"] == ["LOW"]

    def test_low_similarity_not_merged(self):
        a = _f("A", rule_id="r1", line=10, description="SQL injection here")
        b = _f("B", rule_id="r2", line=11,
               description="Completely unrelated cross site scripting problem")
        result, _ = deduplicate_findings([a, b])
        assert len(result) == 2

    def test_similar_text_different_file_not_merged(self):
        a = _f("A", rule_id="r1", file="src/a.js", line=10,
               description="Detected SQL injection via string concatenation")
        b = _f("B", rule_id="r2", file="src/b.js", line=10,
               description="Detected SQL injection via string concatenation")
        result, _ = deduplicate_findings([a, b])
        assert len(result) == 2

    def test_confidence_used_not_severity_for_merge_choice(self):
        # Winner is chosen by CONFIDENCE; the finding with the SCARIER severity
        # but LOWER confidence must NOT automatically win.
        scary_lowconf = _f(
            "SCARY", rule_id="r1", line=10, severity="CRITICAL",
            confidence="low",
            description="Detected SQL injection via concatenation right here",
        )
        calm_highconf = _f(
            "CALM", rule_id="r2", line=11, severity="INFO",
            confidence="high",
            description="Detected SQL injection via concatenation right here.",
        )
        result, merges = deduplicate_findings([scary_lowconf, calm_highconf])
        assert len(result) == 1
        assert result[0].id == "CALM"  # chosen on confidence, not severity


# ── line-window boundary edge case (window = 5, INCLUSIVE) ────────────────


class TestLineWindowBoundary:
    def test_window_documented_constant(self):
        assert dd.SIMILARITY_LINE_WINDOW == 5

    def test_exactly_at_window_boundary_merges_inclusive(self):
        a = _f("A", rule_id="r1", line=10,
               description="Detected SQL injection via string concatenation")
        b = _f("B", rule_id="r2", line=15,  # delta == 5 == window (inclusive)
               description="Detected SQL injection via string concatenation")
        result, _ = deduplicate_findings([a, b])
        assert len(result) == 1  # boundary is INCLUSIVE -> merged

    def test_just_beyond_window_not_merged(self):
        a = _f("A", rule_id="r1", line=10,
               description="Detected SQL injection via string concatenation")
        b = _f("B", rule_id="r2", line=16,  # delta == 6 > window
               description="Detected SQL injection via string concatenation")
        result, _ = deduplicate_findings([a, b])
        assert len(result) == 2  # beyond boundary -> distinct


class TestThreeWayMerge:
    def test_three_similar_findings_collapse_to_one(self):
        # Exercises the inner "already handled" skip and the absorb-chain in
        # the merge record when 3+ near-duplicates fold together.
        a = _f("A", rule_id="r1", line=10, confidence="low",
               description="Detected SQL injection via string concatenation")
        b = _f("B", rule_id="r2", line=11, confidence="medium",
               description="Detected SQL injection via string concatenation!")
        c = _f("C", rule_id="r3", line=12, confidence="high",
               description="Detected SQL injection via string concatenation.")
        result, merges = deduplicate_findings([a, b, c])
        assert len(result) == 1
        survivor = result[0]
        assert survivor.id == "C"  # highest confidence wins the whole chain
        assert set(merges["C"]) == {"A", "B"}


# ── merge-record accounting ──────────────────────────────────────────────


class TestMergeRecordAccounting:
    def test_all_input_ids_accounted_for(self):
        a = _f("A")
        b = _f("B")  # merges into a-or-b (primary)
        c = _f("C", rule_id="rZ", line=500, description="unique unrelated")
        inputs = [a, b, c]
        result, merges = deduplicate_findings(inputs)
        survivor_ids = {x.id for x in result}
        merged_ids = {mid for lst in merges.values() for mid in lst}
        # every input id is either a survivor or recorded as merged, never both
        assert survivor_ids | merged_ids == {"A", "B", "C"}
        assert survivor_ids & merged_ids == set()
        # merge_record is keyed by survivors only
        assert set(merges.keys()) == survivor_ids

    def test_returns_tuple_of_list_and_dict(self):
        out = deduplicate_findings([_f("A")])
        assert isinstance(out, tuple) and len(out) == 2
        assert isinstance(out[0], list)
        assert isinstance(out[1], dict)


# ── determinism ──────────────────────────────────────────────────────────


class TestDeterminism:
    def test_same_input_same_output(self):
        findings = [
            _f("A", rule_id="r1", line=10, description="SQL injection alpha"),
            _f("B", rule_id="r2", line=11, description="SQL injection alpha."),
            _f("C", rule_id="r3", line=90, description="unrelated xss thing"),
        ]
        r1, m1 = deduplicate_findings(list(findings))
        r2, m2 = deduplicate_findings(list(findings))
        assert [x.id for x in r1] == [x.id for x in r2]
        assert m1 == m2
