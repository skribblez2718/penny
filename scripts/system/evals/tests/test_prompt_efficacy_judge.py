"""Unit tests for the hybrid rubric-judge grader (prompt_efficacy_judge).

All judge invocations use an injected fake runner — NO live model call happens.
Covers PRD REQ-001 (judge check type), REQ-002 (AND-combine + raise), REQ-003
(fixed judge constant), REQ-005 (prompt fields), REQ-006 (last-verdict parse),
and the retry-once-then-exclude + majority-of-N behavior.
"""

import json
import subprocess
import types

import pytest

import prompt_efficacy_judge as J


# ----- fakes ---------------------------------------------------------------

def _stream(*texts: str) -> str:
    """A --mode json stdout with one assistant message_end carrying `texts`."""
    msg = {
        "type": "message_end",
        "message": {
            "role": "assistant",
            "stopReason": "stop",
            "content": [{"type": "text", "text": t} for t in texts],
        },
    }
    return json.dumps({"type": "agent_start"}) + "\n" + json.dumps(msg)


def _error_stream() -> str:
    msg = {"type": "message_end", "message": {"role": "assistant", "stopReason": "error",
                                              "errorMessage": "boom", "content": []}}
    return json.dumps(msg)


class FakeRunner:
    """Queue of responses; each is a stdout string, or an Exception to raise."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, cmd, **kwargs):
        self.calls.append(cmd)
        r = self.responses.pop(0)
        if isinstance(r, BaseException):
            raise r
        return types.SimpleNamespace(stdout=r, stderr="", returncode=0)


# ----- REQ-001 / REQ-003 / REQ-005 -----------------------------------------

def test_is_judge_check():
    assert J.is_judge_check({"type": "judge"}) is True
    for t in ("contains_all", "contains_any", "regex", "json_fields"):
        assert J.is_judge_check({"type": t}) is False


def test_judge_model_is_fixed_haiku():
    assert J.JUDGE_MODEL == "anthropic/claude-haiku-4-5"
    assert J.JUDGE_PROVIDER == "anthropic" and J.JUDGE_MODEL_ID == "claude-haiku-4-5"


def test_resolve_judge_model_default_and_env_override(monkeypatch):
    # default (no env) -> the fixed, reproducible haiku judge
    monkeypatch.delenv(J.JUDGE_MODEL_ENV, raising=False)
    assert J.resolve_judge_model() == (
        "anthropic/claude-haiku-4-5", "anthropic", "claude-haiku-4-5")
    # #6: multi-family setups pick a DIFFERENT-family judge via env var
    monkeypatch.setenv(J.JUDGE_MODEL_ENV, "ollama/minimax-m3:cloud")
    assert J.resolve_judge_model() == (
        "ollama/minimax-m3:cloud", "ollama", "minimax-m3:cloud")
    # malformed override falls back to the default (graceful; never crashes a run)
    monkeypatch.setenv(J.JUDGE_MODEL_ENV, "no-slash-here")
    assert J.resolve_judge_model()[1:] == ("anthropic", "claude-haiku-4-5")


def test_call_judge_honors_env_override(monkeypatch):
    monkeypatch.setenv(J.JUDGE_MODEL_ENV, "ollama/minimax-m3:cloud")
    runner = FakeRunner([_stream("VERDICT: PASS")])
    v, _ = J.call_judge("prompt", cwd="/tmp", runner=runner)
    assert v is True
    cmd = runner.calls[0]
    assert "minimax-m3:cloud" in cmd and "ollama" in cmd
    assert "claude-haiku-4-5" not in cmd


def test_build_judge_prompt_includes_all_rubric_fields():
    check = {"type": "judge", "question": "Q?", "pass_bar": "declines/hedges",
             "required_facts": ["it does not exist"], "fail_traps": ["invents details"]}
    p = J.build_judge_prompt(check, "some response")
    for needle in ("Q?", "declines/hedges", "it does not exist", "invents details",
                   "some response", "VERDICT: PASS"):
        assert needle in p


# ----- REQ-006 -------------------------------------------------------------

def test_parse_verdict_last_wins_and_case_insensitive():
    assert J.parse_verdict("verdict: fail\n...\nVERDICT: PASS") is True   # last wins
    assert J.parse_verdict("VERDICT: PASS\nactually VERDICT: fail") is False
    assert J.parse_verdict("no verdict here") is None
    assert J.parse_verdict("") is None


# ----- REQ-002: grade_cell AND-combine + raise -----------------------------

def test_grade_cell_deterministic_only_regression():
    checks = [{"type": "contains_any", "values": ["paris"]}]
    passed, per = J.grade_cell(checks, "The capital is Paris.", judge_fn=None)
    assert passed is True and per["contains_any#0"] is True


def test_grade_cell_judge_only_pass_and_fail():
    checks = [{"type": "judge", "question": "q"}]
    passed, _ = J.grade_cell(checks, "resp", judge_fn=lambda c, t: (True, "ok"))
    assert passed is True
    passed, _ = J.grade_cell(checks, "resp", judge_fn=lambda c, t: (False, "no"))
    assert passed is False


def test_grade_cell_mixed_requires_both():
    checks = [{"type": "judge", "question": "q"}, {"type": "json_fields", "fields": ["a"]}]
    # judge PASS + json present -> pass
    passed, _ = J.grade_cell(checks, '{"a": 1}', judge_fn=lambda c, t: (True, ""))
    assert passed is True
    # judge PASS but json missing -> fail
    passed, _ = J.grade_cell(checks, "no json", judge_fn=lambda c, t: (True, ""))
    assert passed is False


def test_grade_cell_raises_without_judge_fn():
    with pytest.raises(ValueError):
        J.grade_cell([{"type": "judge", "question": "q"}], "resp", judge_fn=None)


def test_grade_cell_judge_error_excludes_cell():
    # judge_fn returns (None, info) -> grade_cell returns (None, ...) => exclude, never PASS
    passed, per = J.grade_cell([{"type": "judge", "question": "q"}], "resp",
                               judge_fn=lambda c, t: (None, "judge failed twice"))
    assert passed is None
    assert per["_judge_error"] == "judge failed twice"


# ----- judge invocation: parse / retry / exclude / majority ----------------

def test_call_judge_uses_fixed_model_never_models_arg():
    runner = FakeRunner([_stream("VERDICT: PASS")])
    verdict, _ = J.call_judge("prompt", cwd="/tmp", runner=runner)
    assert verdict is True
    cmd = runner.calls[0]
    assert "claude-haiku-4-5" in cmd and "anthropic" in cmd
    # the grader system prompt must be passed (non-empty -> avoids OAuth 400)
    assert "--system-prompt" in cmd


def test_make_judge_fn_single_pass():
    jf = J.make_judge_fn(cwd="/tmp", runner=FakeRunner([_stream("VERDICT: PASS")]))
    v, _ = jf({"type": "judge", "question": "q"}, "resp")
    assert v is True


def test_make_judge_fn_retries_once_then_succeeds():
    runner = FakeRunner([_error_stream(), _stream("VERDICT: FAIL")])
    jf = J.make_judge_fn(cwd="/tmp", runner=runner)
    v, _ = jf({"type": "judge", "question": "q"}, "resp")
    assert v is False
    assert len(runner.calls) == 2  # initial + one retry


def test_make_judge_fn_two_failures_excludes():
    runner = FakeRunner([_error_stream(), _error_stream()])
    jf = J.make_judge_fn(cwd="/tmp", runner=runner)
    v, info = jf({"type": "judge", "question": "q"}, "resp")
    assert v is None and "failed twice" in info


def test_make_judge_fn_timeout_excludes():
    runner = FakeRunner([subprocess.TimeoutExpired(cmd="pi", timeout=1),
                         subprocess.TimeoutExpired(cmd="pi", timeout=1)])
    jf = J.make_judge_fn(cwd="/tmp", runner=runner)
    v, _ = jf({"type": "judge", "question": "q"}, "resp")
    assert v is None


def test_make_judge_fn_majority_of_three():
    runner = FakeRunner([_stream("VERDICT: PASS"), _stream("VERDICT: PASS"), _stream("VERDICT: FAIL")])
    jf = J.make_judge_fn(cwd="/tmp", repeats=3, runner=runner)
    v, info = jf({"type": "judge", "question": "q"}, "resp")
    assert v is True  # 2/3 PASS
    assert len(runner.calls) == 3


def test_make_judge_fn_respects_max_calls_cap():
    runner = FakeRunner([_stream("VERDICT: PASS")] * 5)
    jf = J.make_judge_fn(cwd="/tmp", runner=runner, max_calls=2)
    a, _ = jf({"type": "judge", "question": "q"}, "r1")
    b, _ = jf({"type": "judge", "question": "q"}, "r2")
    c, info = jf({"type": "judge", "question": "q"}, "r3")
    assert a is True and b is True
    assert c is None and "cap reached" in info
    assert len(runner.calls) == 2  # the 3rd cell never invoked the judge


def test_unparseable_verdict_is_excluded():
    runner = FakeRunner([_stream("I think it is fine"), _stream("still no verdict")])
    jf = J.make_judge_fn(cwd="/tmp", runner=runner)
    v, _ = jf({"type": "judge", "question": "q"}, "resp")
    assert v is None
