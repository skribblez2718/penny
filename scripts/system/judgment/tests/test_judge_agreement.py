"""Unit tests for the judge-agreement runner and the judgment eval section.

Hermetic: verdict parsing, scoring math (agreement / false-pass / kappa),
corpus/rubric well-formedness, and artifact-reading checks via monkeypatch.
No model endpoint is touched.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

_JUDGMENT = Path(__file__).resolve().parents[1]
_EVALS = _JUDGMENT.parent / "evals"
sys.path.insert(0, str(_JUDGMENT))
sys.path.insert(0, str(_EVALS))

import eval_judgment as ej  # noqa: E402
import run_judge_agreement as rj  # noqa: E402
from eval_lib import FAIL, PASS, SKIP, run_checks  # noqa: E402

# ── Verdict parsing ──────────────────────────────────────────────────────────


def test_parse_verdict_variants():
    assert rj.parse_verdict("VERDICT: PASS\nWHY: ...") == "PASS"
    assert rj.parse_verdict("verdict : fail") == "FAIL"
    assert rj.parse_verdict("Verdict - PASS") == "PASS"
    assert rj.parse_verdict("thinking...\nVERDICT: FAIL because x") == "FAIL"
    assert rj.parse_verdict("I think it is fine") is None
    assert rj.parse_verdict("") is None


def test_parse_verdict_takes_last_not_first():
    # a chatty judge emits a preliminary verdict before the real one — score the LAST
    assert rj.parse_verdict("Preliminary verdict: pass, but broken.\nVERDICT: FAIL") == "FAIL"
    assert rj.parse_verdict("verdict: fail? no.\nFinal VERDICT: PASS") == "PASS"


# ── Corpus + rubric well-formedness (the Oracle asset) ────────────────────────


def test_corpus_is_well_formed_and_covered_by_rubrics():
    corpus = rj.load_corpus()
    rubrics = rj.load_rubrics()
    assert len(corpus) >= 12
    seen = set()
    for rec in corpus:
        assert rec["id"] not in seen, f"duplicate id {rec['id']}"
        seen.add(rec["id"])
        assert rec["oracle_verdict"] in ("PASS", "FAIL")
        assert 0 <= rec["oracle_score"] <= 4
        assert rec["artifact"].strip()
        assert rec["oracle_reasoning"].strip()
        assert rec["class"] in rubrics, f"{rec['class']} has no rubric"
        if rec["oracle_verdict"] == "FAIL":
            assert rec["failure_mode"].strip(), f"{rec['id']} FAIL needs a failure_mode"


def test_corpus_has_both_verdicts_and_hard_cases():
    corpus = rj.load_corpus()
    verdicts = {r["oracle_verdict"] for r in corpus}
    assert verdicts == {"PASS", "FAIL"}, "corpus must contain both verdicts"
    # hard cases = borderline FAILs (score 2): the plausible-but-wrong ones a weak
    # judge waves through. Their presence is what makes the metric meaningful.
    assert any(r["oracle_verdict"] == "FAIL" and r["oracle_score"] == 2 for r in corpus)


def test_rubrics_have_required_fields():
    rubrics = rj.load_rubrics()
    for name, rub in rubrics.items():
        assert rub["question"], name
        assert rub["check"], name
        assert rub["pass_bar"], name


def test_build_judge_prompt_includes_rubric_and_artifact():
    rec = {"id": "x", "class": "plan_quality", "artifact": "STEP ONE do a thing"}
    rubric = {"question": "Q?", "check": ["c1", "c2"], "pass_bar": "PB", "fail_traps": "FT"}
    prompt = rj.build_judge_prompt(rec, rubric)
    assert "Q?" in prompt and "c1" in prompt and "PB" in prompt
    assert "STEP ONE do a thing" in prompt


# ── Scoring math ─────────────────────────────────────────────────────────────


def _cell(id, cls, oracle, judge, error=None):
    return {
        "id": id,
        "class": cls,
        "model": "m",
        "family": "glm",
        "oracle_verdict": oracle,
        "judge_verdict": judge,
        "agree": (judge == oracle) if judge is not None else None,
        "error": error,
    }


def test_score_model_agreement_false_pass_and_false_fail():
    cells = [
        _cell("a", "plan_quality", "PASS", "PASS"),  # correct pass
        _cell("b", "plan_quality", "FAIL", "PASS"),  # FALSE PASS (waved through)
        _cell("c", "finding_validity", "FAIL", "FAIL"),  # correct fail
        _cell("d", "finding_validity", "PASS", "FAIL"),  # false fail (too strict)
    ]
    s = rj.score_model(cells)
    assert s["n"] == 4
    assert s["agreement"] == pytest.approx(0.5)
    assert s["false_pass_rate"] == pytest.approx(0.5)  # 1 of 2 Oracle-FAIL
    assert s["false_fail_rate"] == pytest.approx(0.5)  # 1 of 2 Oracle-PASS
    assert set(s["per_class"]) == {"plan_quality", "finding_validity"}


def test_score_model_excludes_errors_and_unparseable():
    cells = [
        _cell("a", "plan_quality", "PASS", "PASS"),
        _cell("b", "plan_quality", "FAIL", None, error="timeout"),
        _cell("c", "plan_quality", "PASS", None, error="unparseable verdict"),
    ]
    s = rj.score_model(cells)
    assert s["n"] == 1
    assert s["errors"] == 2
    assert s["agreement"] == pytest.approx(1.0)


def test_score_model_all_errors():
    cells = [_cell("a", "plan_quality", "PASS", None, error="timeout")]
    s = rj.score_model(cells)
    assert s["n"] == 0
    assert s["agreement"] is None


def test_cohen_kappa_perfect_and_chance():
    perfect = [
        _cell("a", "c", "PASS", "PASS"),
        _cell("b", "c", "FAIL", "FAIL"),
    ]
    assert rj.cohen_kappa(perfect) == 1.0
    # judge always says PASS while oracle is split → agreement 0.5, kappa 0
    chance = [
        _cell("a", "c", "PASS", "PASS"),
        _cell("b", "c", "FAIL", "PASS"),
    ]
    assert rj.cohen_kappa(chance) == pytest.approx(0.0, abs=1e-9)


# ── best_judge selection ─────────────────────────────────────────────────────


def test_best_judge_picks_highest_agreement_then_lowest_false_pass():
    per_model = {
        "a": {"n": 10, "agreement": 0.8, "false_pass_rate": 0.3},
        "b": {"n": 10, "agreement": 0.9, "false_pass_rate": 0.5},
        "c": {"n": 10, "agreement": 0.9, "false_pass_rate": 0.1},  # ties b on agree, lower FP
    }
    model, s = ej.best_judge(per_model)
    assert model == "c"
    per_model2 = {"x": {"n": 0, "agreement": None}}
    assert ej.best_judge(per_model2) is None


def test_best_judge_prefers_fail_coverage_over_inflated_agreement():
    # 'a' has perfect agreement but scored no Oracle-FAIL records (only easy PASS
    # cases); 'b' has lower agreement but real FAIL coverage. Pick b, so the
    # safety gate is computable and agreement isn't inflated by skipped hard cases.
    per_model = {
        "a": {"n": 7, "agreement": 1.0, "false_pass_rate": None},
        "b": {"n": 15, "agreement": 0.87, "false_pass_rate": 0.12},
    }
    model, s = ej.best_judge(per_model)
    assert model == "b"
    # but if NO judge has FAIL coverage, fall back to agreement-only
    per_model2 = {"a": {"n": 7, "agreement": 1.0, "false_pass_rate": None}}
    model2, _ = ej.best_judge(per_model2)
    assert model2 == "a"


def test_agreement_check_survives_null_kappa(monkeypatch):
    # a corrupt/partial artifact with kappa: null must SKIP-safely, not ERROR
    art = _artifact({"m": {"n": 15, "agreement": 0.8, "false_pass_rate": 0.1, "kappa": None}})
    monkeypatch.setattr(ej, "load_latest", lambda: art)
    result = ej.check_best_judge_agreement()
    assert result.status == PASS  # not an ERROR from None:.2f


# ── Section checks via monkeypatched artifact ────────────────────────────────


def _artifact(per_model, ts=None):
    return {
        "ts": ts or datetime.now(timezone.utc).isoformat(),
        "per_model": per_model,
    }


def test_agreement_check_pass_and_floor_fail(monkeypatch):
    good = _artifact({"m": {"n": 15, "agreement": 0.87, "false_pass_rate": 0.1, "kappa": 0.7}})
    monkeypatch.setattr(ej, "load_latest", lambda: good)
    assert ej.check_best_judge_agreement().status == PASS

    bad = _artifact({"m": {"n": 15, "agreement": 0.4, "false_pass_rate": 0.6, "kappa": 0.0}})
    monkeypatch.setattr(ej, "load_latest", lambda: bad)
    assert ej.check_best_judge_agreement().status == FAIL


def test_false_pass_ceiling(monkeypatch):
    safe = _artifact({"m": {"n": 15, "agreement": 0.8, "false_pass_rate": 0.2}})
    monkeypatch.setattr(ej, "load_latest", lambda: safe)
    assert ej.check_best_judge_false_pass().status == PASS

    unsafe = _artifact({"m": {"n": 15, "agreement": 0.8, "false_pass_rate": 0.5}})
    monkeypatch.setattr(ej, "load_latest", lambda: unsafe)
    assert ej.check_best_judge_false_pass().status == FAIL


def test_checks_skip_when_no_artifact(tmp_path, monkeypatch):
    monkeypatch.setattr(ej, "LATEST_PATH", tmp_path / "missing.json")
    results = {r.name: r for r in run_checks(ej.CHECKS)}
    assert results["judgment.best_judge_agreement"].status == SKIP
    assert results["judgment.best_judge_false_pass_rate"].status == SKIP
    # corpus_size reads the corpus file, not the artifact — stays alive
    assert results["judgment.corpus_size"].status == PASS
    assert results["judgment.corpus_size"].informational


def test_corrupt_artifact_skips_not_errors(tmp_path, monkeypatch):
    path = tmp_path / "latest.json"
    for bad in ({"no": "per_model"}, {"per_model": "not-a-dict"}, "not-json-object"):
        path.write_text(json.dumps(bad) if not isinstance(bad, str) else bad)
        monkeypatch.setattr(ej, "LATEST_PATH", path)
        results = {r.name: r for r in run_checks(ej.CHECKS)}
        assert results["judgment.best_judge_agreement"].status == SKIP, bad
