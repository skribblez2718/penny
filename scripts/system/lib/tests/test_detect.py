"""Tests for the shared detect() primitive (#8). No live model calls — the
subprocess runner is injected on every path."""

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # scripts/system/lib

from detect import detect, extract_json, pi_json_call  # noqa: E402


def _stream(*texts: str) -> str:
    msg = {"type": "message_end", "message": {"role": "assistant", "stopReason": "stop",
           "content": [{"type": "text", "text": t} for t in texts]}}
    return json.dumps({"type": "agent_start"}) + "\n" + json.dumps(msg)


def _err_stream() -> str:
    return json.dumps({"type": "message_end", "message": {"role": "assistant",
                       "stopReason": "error", "content": []}})


def _runner(stdout="", *, returncode=0, raise_exc=None):
    class _Proc:
        pass

    def run(cmd, **kwargs):
        if raise_exc is not None:
            raise raise_exc
        p = _Proc()
        p.stdout, p.stderr, p.returncode = stdout, "", returncode
        return p

    return run


# ── pi_json_call ─────────────────────────────────────────────────────────────


def test_pi_json_call_returns_last_assistant_text():
    out = pi_json_call("p", model_spec="anthropic/haiku", system="s",
                       runner=_runner(_stream('{"answer": 1}')))
    assert out == '{"answer": 1}'


def test_pi_json_call_splits_provider_and_sends_hermetic_flags():
    captured = {}

    def run(cmd, **kwargs):
        captured["cmd"] = cmd

        class _Proc:
            pass
        p = _Proc()
        p.stdout, p.stderr, p.returncode = _stream("ok"), "", 0
        return p

    assert pi_json_call("p", model_spec="ollama/glm5", system="s", runner=run) == "ok"
    cmd = captured["cmd"]
    assert "--provider" in cmd and "ollama" in cmd and "glm5" in cmd
    assert "--no-tools" in cmd and "--no-skills" in cmd  # hermetic


def test_pi_json_call_none_on_all_failure_modes():
    assert pi_json_call("p", model_spec="m", system="s", runner=_runner(_err_stream())) is None
    assert pi_json_call("p", model_spec="m", system="s", runner=_runner("x", returncode=1)) is None
    assert pi_json_call("p", model_spec="m", system="s",
                        runner=_runner(raise_exc=subprocess.TimeoutExpired("pi", 1))) is None
    assert pi_json_call("p", model_spec="m", system="s",
                        runner=_runner(raise_exc=OSError("x"))) is None


# ── extract_json ─────────────────────────────────────────────────────────────


def test_extract_json():
    assert extract_json('prefix {"a": 1} suffix') == {"a": 1}
    assert extract_json("no json here") is None
    assert extract_json(None) is None


# ── detect ───────────────────────────────────────────────────────────────────


def test_detect_success_and_confidence_normalized():
    payload = json.dumps({"answer": "coding", "evidence": ["uses uv.lock"], "confidence": "certain"})
    r = detect("uv.lock present", "what domain?", model_spec="anthropic/haiku",
               labels=["coding", "planning"], runner=_runner(_stream(payload)))
    assert r == {"ok": True, "answer": "coding", "evidence": ["uses uv.lock"], "confidence": "CERTAIN"}


def test_detect_bad_confidence_defaults_probable():
    r = detect("a", "q", model_spec="m", runner=_runner(_stream(json.dumps({"answer": "x", "confidence": "meh"}))))
    assert r["ok"] and r["confidence"] == "PROBABLE" and r["evidence"] == []


def test_detect_no_model_spec_returns_fail_sentinel():
    assert detect("a", "q", model_spec="") == {
        "ok": False, "answer": None, "evidence": [], "confidence": "UNCERTAIN"}


def test_detect_unparseable_returns_fail_sentinel():
    r = detect("a", "q", model_spec="m", runner=_runner(_stream("not json, no answer")))
    assert r["ok"] is False and r["answer"] is None


def test_detect_offers_the_label_menu():
    captured = {}

    def run(cmd, **kwargs):
        captured["prompt"] = cmd[-1]

        class _Proc:
            pass
        p = _Proc()
        p.stdout, p.stderr, p.returncode = _stream('{"answer":"red"}'), "", 0
        return p

    detect("art", "pick one", model_spec="m", labels=["red", "blue"], runner=run)
    assert "red" in captured["prompt"] and "blue" in captured["prompt"]
    assert "ALLOWED ANSWERS" in captured["prompt"]
