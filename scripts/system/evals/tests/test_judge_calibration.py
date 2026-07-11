"""Judge-calibration aggregation + gate — pure functions, no model calls.

Covers agreement, false-pass (overall + claude slice), exclusion of unscored
records, the 0.80/0.20 gate, draft-approval detection, and corpus/rubric loading.
"""

import math

import run_judge_calibration as C


def test_compute_metrics_agreement_false_pass_and_exclusion():
    scored = [
        {"gold": "PASS", "verdict": True, "family": "claude"},   # agree
        {"gold": "FAIL", "verdict": False, "family": "glm"},     # agree
        {"gold": "FAIL", "verdict": True, "family": "claude"},   # disagree + false-pass
        {"gold": "PASS", "verdict": None, "family": "deepseek"}, # excluded
    ]
    m = C.compute_metrics(scored)
    assert m["n_scored"] == 3 and m["n_excluded"] == 1
    assert math.isclose(m["agreement"], 2 / 3, rel_tol=1e-6)
    assert math.isclose(m["false_pass_overall"], 0.5, rel_tol=1e-6)  # 1 of 2 FAILs judged PASS
    assert m["false_pass_by_family"]["claude"]["false_pass"] == 1.0   # the 1 claude FAIL was passed
    assert m["false_pass_by_family"]["glm"]["false_pass"] == 0.0


def test_gate_fails_on_low_agreement_and_high_false_pass():
    scored = [
        {"gold": "PASS", "verdict": True, "family": "claude"},
        {"gold": "FAIL", "verdict": True, "family": "claude"},   # false-pass, claude
        {"gold": "FAIL", "verdict": True, "family": "glm"},      # false-pass
    ]
    ok, reasons = C.gate_verdict(C.compute_metrics(scored))
    assert ok is False
    joined = " ".join(reasons)
    assert "agreement" in joined and "false-pass" in joined and "claude-slice" in joined


def test_gate_passes_within_thresholds():
    scored = [
        {"gold": "PASS", "verdict": True, "family": "claude"},
        {"gold": "FAIL", "verdict": False, "family": "claude"},
        {"gold": "FAIL", "verdict": False, "family": "glm"},
        {"gold": "PASS", "verdict": True, "family": "glm"},
        {"gold": "FAIL", "verdict": False, "family": "deepseek"},
    ]
    ok, _ = C.gate_verdict(C.compute_metrics(scored))
    assert ok is True


def test_approval_detection_requires_both_markers():
    # Logic is tested with synthetic data (the real files are approved post-merge).
    assert C.corpus_approved({"approval": {"approved_by": "user", "approved_at": "2026-07-10"}}) is True
    assert C.corpus_approved({"approval": {"approved_by": "user"}}) is False
    assert C.corpus_approved({}) is False
    assert C.rubrics_approved({"_approval": {"approved_by": "u", "approved_at": "d"}}) is True
    assert C.rubrics_approved({"_approval": {"approved_at": "d"}}) is False
    assert C.rubrics_approved({}) is False


def test_load_corpus_skips_meta_and_reads_records():
    records = C.load_corpus()
    assert len(records) == 13  # 13 labeled records; the _meta line is skipped
    assert all("gold" in r and "task_id" in r for r in records)


def test_score_corpus_missing_rubric_excludes():
    records = [
        {"id": "a", "task_id": "fab-nonexistent-flag", "gold": "PASS", "response": "x", "family": "glm"},
        {"id": "b", "task_id": "no-such-task", "gold": "FAIL", "response": "y", "family": "kimi"},
    ]
    rubrics = {"fab-nonexistent-flag": {"type": "judge", "question": "q"}}
    scored = C.score_corpus(records, rubrics, judge_fn=lambda rubric, resp: (True, "ok"))
    assert scored[0]["verdict"] is True
    assert scored[1]["verdict"] is None  # no rubric -> excluded, never PASS


def test_all_pilot_rubrics_have_a_corpus_reference():
    # every pilot rubric task_id should be exercised by at least one corpus record
    rubric_ids = set(C.load_rubrics().keys())
    corpus_task_ids = {r["task_id"] for r in C.load_corpus()}
    assert rubric_ids <= corpus_task_ids, rubric_ids - corpus_task_ids
