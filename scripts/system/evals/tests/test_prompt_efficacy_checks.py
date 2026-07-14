"""Unit tests for the prompt_efficacy eval section and runner helpers.

Everything here is hermetic: graders and frame sectioning are pure functions;
artifact-reading checks are exercised via monkeypatched load_latest. Nothing
touches a model endpoint (the runner's subprocess path is integration-lane).
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

import eval_prompt_efficacy as pe
import run_prompt_efficacy as runner
from eval_lib import FAIL, PASS, SKIP, run_checks

# ── Graders ─────────────────────────────────────────────────────────────────


def test_contains_all_case_insensitive_by_default():
    check = {"type": "contains_all", "values": ["Keyring.py", "LINE 12"]}
    assert pe.check_text(check, "the crash was in keyring.py at line 12")
    assert not pe.check_text(check, "the crash was in keyring.py")


def test_contains_any_and_none():
    assert pe.check_text({"type": "contains_any", "values": ["x", "y"]}, "has y here")
    assert not pe.check_text({"type": "contains_any", "values": ["x", "y"]}, "nothing")
    assert pe.check_text({"type": "contains_none", "values": ["bad"]}, "all good")
    assert not pe.check_text({"type": "contains_none", "values": ["bad"]}, "bad news")


def test_regex_and_regex_none():
    assert pe.check_text({"type": "regex", "pattern": r"(?m)^\s*5[.)]"}, "text\n5. five")
    assert not pe.check_text({"type": "regex", "pattern": r"(?m)^\s*5[.)]"}, "5 items")
    assert pe.check_text({"type": "regex_none", "pattern": r"(?m)^\s*6[.)]"}, "1. one")
    assert not pe.check_text({"type": "regex_none", "pattern": r"(?m)^6[.)]"}, "6. six")


def test_case_sensitive_flag():
    check = {"type": "contains_all", "values": ["Foo"], "case_sensitive": True}
    assert pe.check_text(check, "Foo bar")
    assert not pe.check_text(check, "foo bar")


def test_json_fields_from_fenced_block_and_raw():
    fenced = 'here\n```json\n{"status": "ok", "root_cause": "x", "action_items": []}\n```'
    check = {"type": "json_fields", "fields": ["status", "root_cause", "action_items"]}
    assert pe.check_text(check, fenced)
    raw = 'prefix {"status": "ok", "root_cause": "x", "action_items": ["a"]} suffix'
    assert pe.check_text(check, raw)
    assert not pe.check_text(check, '{"status": "ok"}')
    assert not pe.check_text(check, "no json at all")


def test_extract_json_object_handles_brace_in_string():
    obj = pe.extract_json_object('Result: {"note": "closes with }", "status": "ok"}')
    assert obj == {"note": "closes with }", "status": "ok"}


def test_extract_json_object_skips_prose_braces_before_json():
    obj = pe.extract_json_object('In {short} form: {"status": "ok", "confidence": "high"}')
    assert obj == {"status": "ok", "confidence": "high"}
    obj2 = pe.extract_json_object('partial { oops... then {"status": "ok"}')
    assert obj2 == {"status": "ok"}


def test_extract_json_object_handles_escaped_quotes():
    obj = pe.extract_json_object('{"note": "he said \\"hi\\" }", "ok": true}')
    assert obj == {"note": 'he said "hi" }', "ok": True}


def test_json_fields_grader_with_embedded_brace():
    check = {"type": "json_fields", "fields": ["status", "root_cause"]}
    assert pe.check_text(check, 'answer: {"status": "rolled back }", "root_cause": "x"}')


def test_unknown_check_type_raises():
    with pytest.raises(ValueError):
        pe.check_text({"type": "nope"}, "text")


def test_regex_check_missing_pattern_raises():
    with pytest.raises(ValueError):
        pe.check_text({"type": "regex"}, "anything")
    with pytest.raises(ValueError):
        pe.check_text({"type": "regex_none", "pattern": ""}, "anything")


def test_grade_text_all_checks_must_pass():
    checks = [
        {"type": "contains_all", "values": ["a"]},
        {"type": "contains_none", "values": ["z"]},
    ]
    passed, outcomes = pe.grade_text(checks, "a b c")
    assert passed and len(outcomes) == 2
    passed, outcomes = pe.grade_text(checks, "a z")
    assert not passed
    assert outcomes["contains_all#0"] is True
    assert outcomes["contains_none#1"] is False


# ── Golden task file sanity ─────────────────────────────────────────────────


def test_golden_tasks_load_and_are_well_formed():
    tasks = pe.load_golden_tasks()
    assert len(tasks) >= 10
    seen = set()
    for task in tasks:
        assert task["id"] not in seen, f"duplicate task id {task['id']}"
        seen.add(task["id"])
        assert task["prompt"].strip()
        assert task["checks"], f"task {task['id']} has no graders"
        for check in task["checks"]:
            if check.get("type") == "judge":
                # hybrid judge check: validate rubric completeness + approval markers
                assert check.get("question") and check.get("pass_bar"), (
                    f"judge task {task['id']} has an incomplete rubric"
                )
                assert check.get("approved_by") and check.get("approved_at"), (
                    f"judge task {task['id']} rubric is not approved (decision #4)"
                )
            else:
                # deterministic check: raises ValueError on unknown types
                pe.check_text(check, "probe text")


# ── family_rates (artifact math) ────────────────────────────────────────────


def _cell(task, family, arm, passed, error=None, trial=0):
    return {
        "task_id": task,
        "family": family,
        "arm": arm,
        "trial": trial,
        "passed": passed,
        "error": error,
    }


def test_family_rates_pairs_arms_and_averages_trials():
    artifact = {
        "cells": [
            _cell("t1", "glm", "on", True),
            _cell("t1", "glm", "on", False, trial=1),
            _cell("t1", "glm", "off", False),
            _cell("t1", "glm", "off", False, trial=1),
            _cell("t2", "glm", "on", True),
            _cell("t2", "glm", "off", True),
        ]
    }
    rates = pe.family_rates(artifact)
    assert rates["glm"]["n"] == 2
    assert rates["glm"]["on"] == pytest.approx(0.75)  # (0.5 + 1.0) / 2
    assert rates["glm"]["off"] == pytest.approx(0.5)
    assert rates["glm"]["delta"] == pytest.approx(0.25)


def test_family_rates_ignores_errors_unpaired_tasks_and_ablations():
    artifact = {
        "cells": [
            _cell("t1", "glm", "on", True),
            _cell("t1", "glm", "off", True, error="timeout"),  # errored → t1 unpaired
            _cell("t2", "glm", "on", True),  # no off arm → unpaired
            _cell("t3", "glm", "ablate:tools", True),  # ablation → not gated here
            _cell("t4", "kimi", "on", True),
            _cell("t4", "kimi", "off", False),
        ]
    }
    rates = pe.family_rates(artifact)
    assert "glm" not in rates
    assert rates["kimi"]["n"] == 1
    assert rates["kimi"]["delta"] == pytest.approx(1.0)


# ── Section checks via monkeypatched artifact ───────────────────────────────


def _artifact(ts=None, cells=None):
    return {
        "ts": ts or datetime.now(timezone.utc).isoformat(),
        "cells": cells if cells is not None else [_cell("t1", "glm", "on", True)],
    }


def test_results_fresh_days(monkeypatch):
    old = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    monkeypatch.setattr(pe, "load_latest", lambda: _artifact(ts=old))
    result = pe.check_results_fresh()
    assert result.status == PASS
    assert result.value == pytest.approx(3.0, abs=0.1)


def test_frame_gain_overall_is_informational_and_never_gates(monkeypatch):
    # A positive gain is reported but does not gate.
    good = [_cell("t1", "glm", "on", True), _cell("t1", "glm", "off", False)]
    monkeypatch.setattr(pe, "load_latest", lambda: _artifact(cells=good))
    r = pe.check_frame_gain_overall()
    assert r.status == PASS and r.informational is True
    assert r.direction == ""  # no direction ⇒ not a ratchet metric
    assert r.value == pytest.approx(1.0)

    # Even a frame that adds nothing (gain → 0, the Bitter-Lesson case) or one
    # that looks net-negative must NOT gate here — harm is guarded elsewhere.
    for on, off, expect in ((True, True, 0.0), (False, True, -1.0)):
        cells = [
            c
            for i in range(10)
            for c in (_cell(f"t{i}", "glm", "on", on), _cell(f"t{i}", "glm", "off", off))
        ]
        monkeypatch.setattr(pe, "load_latest", lambda cells=cells: _artifact(cells=cells))
        result = pe.check_frame_gain_overall()
        assert result.status == PASS and result.informational is True
        assert result.value == pytest.approx(expect)


def test_frame_on_pass_rate_aggregate_is_informational(monkeypatch):
    # The cross-family MEAN is roster-sensitive, so it is informational (never gates).
    cells = [
        _cell("t1", "claude", "on", True), _cell("t1", "claude", "off", False),
        _cell("t2", "claude", "on", False), _cell("t2", "claude", "off", True),
    ]
    monkeypatch.setattr(pe, "load_latest", lambda: _artifact(cells=cells))
    r = pe.check_frame_on_pass_rate()
    assert r.status == PASS and r.informational is True
    assert r.direction == ""  # no direction ⇒ not a ratchet metric
    assert r.value == pytest.approx(0.5)


def test_frame_on_per_family_floors_are_ratcheted_and_independent(monkeypatch):
    # claude on=1.0, glm on=0.5 -> one ratcheted metric each, keyed by family.
    cells = [
        _cell("t1", "claude", "on", True), _cell("t1", "claude", "off", True),
        _cell("t2", "claude", "on", True), _cell("t2", "claude", "off", True),
        _cell("t1", "glm", "on", True), _cell("t1", "glm", "off", False),
        _cell("t2", "glm", "on", False), _cell("t2", "glm", "off", False),
    ]
    monkeypatch.setattr(pe, "load_latest", lambda: _artifact(cells=cells))
    res = {r.name: r for r in pe._frame_on_per_family_results()}
    assert set(res) == {
        "prompt_efficacy.frame_on_pass_rate.claude",
        "prompt_efficacy.frame_on_pass_rate.glm",
    }
    for r in res.values():
        assert r.direction == pe.UP_GOOD and not r.informational and r.unit == "fraction"
    assert res["prompt_efficacy.frame_on_pass_rate.claude"].value == pytest.approx(1.0)
    assert res["prompt_efficacy.frame_on_pass_rate.glm"].value == pytest.approx(0.5)


def test_frame_on_per_family_empty_and_collect_clean_when_no_artifact(tmp_path, monkeypatch):
    monkeypatch.setattr(pe, "LATEST_PATH", tmp_path / "missing.json")
    assert pe._frame_on_per_family_results() == []
    names = {r.name for r in pe.collect()}
    assert "prompt_efficacy.frame_on_pass_rate" in names  # aggregate still SKIPs
    assert not any(n.startswith("prompt_efficacy.frame_on_pass_rate.") for n in names)


def test_frame_regressed_families_respects_min_sample_and_margin(monkeypatch):
    # 10 tasks, frame-on loses 4 → delta -0.4, margin max(0.05, 0.2) = 0.2 → degraded
    degraded = []
    for i in range(10):
        degraded.append(_cell(f"t{i}", "kimi", "on", i >= 4))
        degraded.append(_cell(f"t{i}", "kimi", "off", True))
    # only 3 tasks for glm (below MIN_FAMILY_TASKS) with a huge deficit → not counted
    for i in range(3):
        degraded.append(_cell(f"g{i}", "glm", "on", False))
        degraded.append(_cell(f"g{i}", "glm", "off", True))
    monkeypatch.setattr(pe, "load_latest", lambda: _artifact(cells=degraded))
    result = pe.check_frame_regressed_families()
    assert result.status == FAIL
    assert result.value == 1.0
    assert "kimi" in result.detail and "glm" not in result.detail


def test_checks_skip_when_no_artifact(tmp_path, monkeypatch):
    monkeypatch.setattr(pe, "LATEST_PATH", tmp_path / "missing.json")
    results = run_checks(pe.CHECKS)
    by_name = {r.name: r for r in results}
    assert by_name["prompt_efficacy.results_fresh_days"].status == SKIP
    assert by_name["prompt_efficacy.frame_gain_overall"].status == SKIP
    assert by_name["prompt_efficacy.frame_on_pass_rate"].status == SKIP
    # task_count reads the golden file, not the artifact — stays alive
    assert by_name["prompt_efficacy.task_count"].status == PASS
    assert by_name["prompt_efficacy.task_count"].informational


def test_corrupt_artifact_skips_not_errors(tmp_path, monkeypatch):
    # A structurally broken artifact must SKIP (prerequisite absent), never ERROR
    # (which gates like FAIL). cells must be a non-empty list of dicts.
    for bad in ([], "not-a-list", [1, 2, 3], {"no": "cells"}):
        path = tmp_path / "latest.json"
        path.write_text(json.dumps({"ts": "2026-07-07T00:00:00Z", "cells": bad}))
        monkeypatch.setattr(pe, "LATEST_PATH", path)
        results = run_checks(pe.CHECKS)
        by_name = {r.name: r for r in results}
        assert by_name["prompt_efficacy.frame_gain_overall"].status == SKIP, bad
        assert by_name["prompt_efficacy.cell_error_rate"].status == SKIP, bad


def test_degradation_margin_scales_with_task_count():
    assert pe.degradation_margin(10) == pytest.approx(0.2)
    assert pe.degradation_margin(40) == pytest.approx(0.05)
    assert pe.degradation_margin(100) == pytest.approx(0.05)
    assert pe.degradation_margin(0) == 1.0


# ── Runner helpers (no subprocess) ──────────────────────────────────────────


FRAME_SAMPLE = """<system_directives>
rules
</system_directives>

<system_context>

# Who You Are

identity text

# Tools

tool text

# Output Contract

contract text
</system_context>
"""


def test_frame_sections_and_ablation():
    sections = runner.frame_sections(FRAME_SAMPLE)
    slugs = [s for s, _ in sections]
    assert slugs == ["who-you-are", "tools", "output-contract"]
    ablated = runner.ablated_frame(FRAME_SAMPLE, dict(sections)["tools"])
    assert "tool text" not in ablated
    assert "identity text" in ablated
    assert "<system_directives>" in ablated  # never ablate outside system_context


def test_frame_sections_empty_without_context_block():
    assert runner.frame_sections("# Heading\nno context block") == []


def test_family_of():
    assert runner.family_of("glm-5.2:cloud") == "glm"
    assert runner.family_of("deepseek-v4-pro:cloud") == "deepseek"
    assert runner.family_of("kimi-k2.7-code:cloud") == "kimi"
    assert runner.family_of("minimax-m3:cloud") == "minimax"
    assert runner.family_of("claude-sonnet-5") == "claude"
    assert runner.family_of("qwen3.6:27b-coder") == "qwen"


def test_parse_model_spec():
    assert runner.parse_model_spec("anthropic/claude-sonnet-5") == (
        "anthropic",
        "claude-sonnet-5",
    )
    assert runner.parse_model_spec("glm-5.2:cloud") == ("ollama", "glm-5.2:cloud")


def test_run_cell_parses_message_end_stream(monkeypatch, tmp_path):
    events = [
        {"type": "session", "version": 3},
        {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "..."},
                    {"type": "text", "text": "the crash was in keyring.py line 12, empty keys"},
                ],
                "usage": {"input": 10, "output": 20, "reasoning": 5},
                "stopReason": "stop",
            },
        },
    ]
    stdout = "\n".join(json.dumps(e) for e in events)

    class FakeProc:
        returncode = 0
        stderr = ""

    FakeProc.stdout = stdout
    monkeypatch.setattr(runner.subprocess, "run", lambda *a, **k: FakeProc())
    task = {
        "id": "t",
        "prompt": "p",
        "checks": [{"type": "contains_all", "values": ["keyring.py", "line 12"]}],
    }
    cell = runner.run_cell(task, "ollama", "glm-5.2:cloud", "on", 0, None, tmp_path, "low", 30)
    assert cell["passed"] is True
    assert cell["error"] is None
    assert cell["tokens_in"] == 10
    assert cell["tokens_out"] == 25  # output + reasoning
    assert cell["stop_reason"] == "stop"


def test_run_cell_no_assistant_message_is_error(monkeypatch, tmp_path):
    class FakeProc:
        returncode = 1
        stdout = '{"type": "session", "version": 3}'
        stderr = "No API key found for anthropic."

    monkeypatch.setattr(runner.subprocess, "run", lambda *a, **k: FakeProc())
    task = {"id": "t", "prompt": "p", "checks": []}
    cell = runner.run_cell(task, "anthropic", "claude-sonnet-5", "on", 0, None, tmp_path, "low", 30)
    assert cell["error"] is not None
    assert "No API key" in cell["error"]
    assert cell["passed"] is False


def test_run_cell_stop_reason_error(monkeypatch, tmp_path):
    event = {
        "type": "message_end",
        "message": {
            "role": "assistant",
            "content": [],
            "stopReason": "error",
            "errorMessage": "boom",
            "usage": {},
        },
    }

    class FakeProc:
        returncode = 0
        stdout = json.dumps(event)
        stderr = ""

    monkeypatch.setattr(runner.subprocess, "run", lambda *a, **k: FakeProc())
    cell = runner.run_cell(
        {"id": "t", "prompt": "p", "checks": []},
        "ollama",
        "glm-5.2:cloud",
        "on",
        0,
        None,
        tmp_path,
        "low",
        30,
    )
    assert cell["error"] is not None and "boom" in cell["error"]
