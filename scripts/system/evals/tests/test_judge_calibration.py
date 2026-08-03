"""Judge-calibration aggregation + gate — pure functions, no model calls.

Covers agreement, false-pass (overall + claude slice), exclusion of unscored
records, the 0.80/0.20 gate, draft-approval detection, and corpus/rubric loading.
"""

import json
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
    # judge_family pinned so the test states its own premise ("the judge is a claude
    # model") instead of depending on whichever judge is configured today.
    ok, reasons = C.gate_verdict(C.compute_metrics(scored), judge_family="claude")
    assert ok is False
    joined = " ".join(reasons)
    assert "agreement" in joined and "false-pass" in joined and "claude-slice" in joined


def test_family_slice_tracks_the_judge_not_a_hardcoded_vendor():
    """#6 revised: the self-grading-risk slice must follow the judge. The SAME data
    gates differently depending on which family the judge belongs to."""
    scored = [
        # agreement is high (4/5); only the glm slice has a false-pass
        {"gold": "PASS", "verdict": True, "family": "claude"},
        {"gold": "FAIL", "verdict": False, "family": "claude"},
        {"gold": "PASS", "verdict": True, "family": "glm"},
        {"gold": "FAIL", "verdict": True, "family": "glm"},      # false-pass, glm only
        {"gold": "PASS", "verdict": True, "family": "openai"},
    ]
    metrics = C.compute_metrics(scored)
    # a glm judge is blind on its own family -> the slice must catch it
    ok_glm, reasons_glm = C.gate_verdict(metrics, judge_family="glm")
    assert ok_glm is False
    assert "glm-slice" in " ".join(reasons_glm)
    # a claude judge is NOT implicated by a glm false-pass -> slice must not fire
    _, reasons_claude = C.gate_verdict(metrics, judge_family="claude")
    assert "claude-slice" not in " ".join(reasons_claude)
    # a judge whose family is absent from the corpus -> slice simply does not apply
    _, reasons_absent = C.gate_verdict(metrics, judge_family="kimi")
    assert "kimi-slice" not in " ".join(reasons_absent)


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


def test_artifact_records_the_resolved_judge_identity(tmp_path, monkeypatch):
    """Calibration evidence without the measuring instrument's identity is not
    reproducible — especially after a judge swap."""
    monkeypatch.setattr(C, "RESULTS_DIR", tmp_path)
    monkeypatch.setenv("PI_EVAL_JUDGE_MODEL", "openai-codex/gpt-5.6-luna")
    path = C.write_artifact(
        {"gate_pass": True},
        [{"id": "x", "gold": "PASS", "verdict": True, "family": "glm"}],
        {"rubrics_approved": True, "corpus_approved": True},
        repeats=3,
    )
    artifact = json.loads(path.read_text(encoding="utf-8"))
    assert artifact["judge"] == {
        "spec": "openai-codex/gpt-5.6-luna",
        "provider": "openai-codex",
        "model": "gpt-5.6-luna",
        "family": "openai",
        "repeats": 3,
    }
