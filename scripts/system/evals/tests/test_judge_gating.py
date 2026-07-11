"""Gating + grading-scheme logic for the hybrid judge runner (decision #4).

Pure functions in run_prompt_efficacy — no model calls. A default (non-experimental)
run must REFUSE judge-graded tasks whose rubrics lack approval markers; the artifact
must carry a grading_scheme so keyword vs judge pass rates are never diffed.
"""

import run_prompt_efficacy as rpe

JUDGE_APPROVED = {"type": "judge", "question": "q", "approved_by": "user", "approved_at": "2026-07-10"}
JUDGE_UNAPPROVED = {"type": "judge", "question": "q"}
DET = {"type": "contains_any", "values": ["x"]}


def test_task_has_judge():
    assert rpe.task_has_judge({"id": "t", "checks": [JUDGE_UNAPPROVED]}) is True
    assert rpe.task_has_judge({"id": "t", "checks": [DET]}) is False
    assert rpe.task_has_judge({"id": "t"}) is False


def test_rubric_approved_requires_both_markers():
    assert rpe.rubric_approved(JUDGE_APPROVED) is True
    assert rpe.rubric_approved({"type": "judge", "approved_by": "user"}) is False
    assert rpe.rubric_approved({"type": "judge", "approved_at": "2026-07-10"}) is False
    assert rpe.rubric_approved(JUDGE_UNAPPROVED) is False


def test_unapproved_judge_tasks_lists_only_unapproved_judge_tasks():
    tasks = [
        {"id": "approved", "checks": [JUDGE_APPROVED]},
        {"id": "unapproved", "checks": [JUDGE_UNAPPROVED]},
        {"id": "deterministic", "checks": [DET]},
    ]
    assert rpe.unapproved_judge_tasks(tasks) == ["unapproved"]


def test_grading_scheme_marker():
    det_only = [{"id": "a", "checks": [DET]}]
    with_judge = [{"id": "b", "checks": [JUDGE_APPROVED]}]
    assert rpe.grading_scheme(det_only, experimental=False) == "keyword"
    assert rpe.grading_scheme(with_judge, experimental=False) == "hybrid-judge-v1"
    assert rpe.grading_scheme(with_judge, experimental=True) == "hybrid-judge-v1-experimental"
