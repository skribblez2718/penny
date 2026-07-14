"""Unit tests for judge-backed auto-capture.

Hermetic: the judge subprocess and the ledger writer are monkeypatched; the
observability read uses an in-memory sqlite matching the real entries schema.
The live pi-spawn path is exercised only in integration.
"""

import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest  # noqa: E402

from outcome_ledger import auto_capture as ac  # noqa: E402


def _obs(rows):
    con = sqlite3.connect(":memory:")
    con.execute(
        "CREATE TABLE entries (id INTEGER PRIMARY KEY, session_id TEXT, "
        "event_type TEXT, role TEXT, timestamp INTEGER, data JSON)"
    )
    for row in rows:
        sid, role, ts, text = row[0], row[1], row[2], row[3]
        stop = row[4] if len(row) > 4 else "stop"
        blob = {"content": [{"type": "text", "text": text}]}
        if role == "assistant":
            blob["stopReason"] = stop
        con.execute(
            "INSERT INTO entries (session_id, role, timestamp, data) VALUES (?,?,?,?)",
            (sid, role, ts, json.dumps(blob)),
        )
    con.commit()
    return con


# ── parsing helpers ──────────────────────────────────────────────────────────


def test_parse_reason():
    assert ac.parse_reason("VERDICT: FAIL\nWHY: dropped the auth edge case") == (
        "dropped the auth edge case"
    )
    assert ac.parse_reason("VERDICT: PASS") == ""


def test_parse_reason_takes_last_line_anchored():
    # a mid-sentence "why" before the real WHY line must not poison the reason
    text = "The goal asks why - the user wants X.\nVERDICT: FAIL\nWHY: answer was factually wrong"
    assert ac.parse_reason(text) == "answer was factually wrong"


def test_parse_failure_mode_normalizes_to_vocab():
    assert (
        ac.parse_failure_mode("VERDICT: FAIL\nWHY: x\nFAILURE_MODE: missing_constraint")
        == "missing_constraint"
    )
    # case/space tolerant
    assert ac.parse_failure_mode("FAILURE_MODE:  Wrong_Result ") == "wrong_result"
    # #19 open-vocab: an off-menu tag is preserved as a snake_case token
    assert ac.parse_failure_mode("FAILURE_MODE: some nonsense") == "some_nonsense"
    # PASS-style / absent → empty (never enters the compression loop)
    assert ac.parse_failure_mode("FAILURE_MODE: none") == ""
    assert ac.parse_failure_mode("VERDICT: PASS") == ""


def test_delta_mapping():
    assert ac._DELTA == {"PASS": "MATCH", "FAIL": "MISMATCH"}


def test_opening_response_is_answer_to_opening_goal():
    con = _obs(
        [
            ("s1", "user", 1, "do the thing"),
            ("s1", "assistant", 2, "first attempt"),
            ("s1", "assistant", 3, "final answer to the opening goal"),
        ]
    )
    assert ac.opening_response(con, "s1") == "final answer to the opening goal"


def test_opening_response_stops_at_second_user_turn_multitask():
    # THE BUG THIS GUARDS: a multi-task session. The opening goal's answer is
    # "auth done" — NOT "kitty installed" (a later, different task). Pairing
    # first-user with last-assistant would mislabel this as off-topic MISMATCH.
    con = _obs(
        [
            ("s1", "user", 1, "refactor the auth module"),
            ("s1", "assistant", 2, "auth done, tests pass"),
            ("s1", "user", 3, "now install kitty terminal"),
            ("s1", "assistant", 4, "kitty installed"),
        ]
    )
    assert ac.opening_response(con, "s1") == "auth done, tests pass"


def test_opening_response_empty_when_no_assistant():
    con = _obs([("s1", "user", 1, "do the thing")])
    assert ac.opening_response(con, "s1") == ""


def test_opening_response_skips_non_stop_interim_messages():
    # THE F1 GUARD: toolUse narration / aborted partials before the real answer
    # must NOT be taken as the answer (they'd cause a false FAIL + dedup block).
    con = _obs(
        [
            ("s1", "user", 1, "refactor the auth module"),
            ("s1", "assistant", 2, "Let me check the config first.", "toolUse"),
            ("s1", "assistant", 3, "auth refactored, tests pass", "stop"),
        ]
    )
    assert ac.opening_response(con, "s1") == "auth refactored, tests pass"


def test_opening_response_empty_when_only_interim():
    # opening exchange has only non-stop messages → no usable answer → skip
    # (falls through to `make rate`), never a fabricated FAIL.
    con = _obs(
        [
            ("s1", "user", 1, "refactor the auth module"),
            ("s1", "assistant", 2, "Let me check the config first.", "toolUse"),
            ("s1", "user", 3, "actually never mind"),
        ]
    )
    assert ac.opening_response(con, "s1") == ""


def test_recent_unrated_tasks_pairs_goal_and_response_and_dedups():
    con = _obs(
        [
            ("s1", "user", 10, "refactor the auth module thoroughly please"),
            ("s1", "assistant", 11, "I refactored it and tests pass"),
            ("s2", "user", 20, "research the CVE and locate a public PoC exploit"),
            ("s2", "assistant", 21, "here is the PoC and analysis"),
            ("s3", "user", 30, "a task whose session has no assistant response yet at all"),
        ]
    )
    tasks = ac.recent_unrated_tasks(con, existing_ids=set(), limit=10)
    ids = {t[0] for t in tasks}
    assert ids == {"s1", "s2"}  # s3 has no response → excluded
    # already-rated session is filtered out
    from outcome_ledger.capture import default_decision_id

    existing = {default_decision_id("s1", "refactor the auth module thoroughly please")}
    tasks2 = ac.recent_unrated_tasks(con, existing_ids=existing, limit=10)
    assert {t[0] for t in tasks2} == {"s2"}


# ── run() orchestration with judge + writer injected ─────────────────────────


def test_run_dry_run_lists_without_judging(monkeypatch):
    con = _obs(
        [
            ("s1", "user", 10, "refactor the auth module thoroughly please"),
            ("s1", "assistant", 11, "done, tests pass"),
        ]
    )
    monkeypatch.setattr(ac, "open_obs", lambda: con)
    monkeypatch.setattr(ac, "existing_decision_ids", lambda: set())
    # judge must NOT be called on dry-run
    monkeypatch.setattr(ac, "judge_task", lambda *a, **k: pytest.fail("judged on dry-run"))
    result = ac.run(limit=10, max_judge=15, model_spec="ollama/minimax-m3:cloud", dry_run=True)
    assert result["would_judge"] == 1


def test_run_records_judge_verdicts(monkeypatch):
    con = _obs(
        [
            ("s1", "user", 10, "refactor the auth module thoroughly please"),
            ("s1", "assistant", 11, "I refactored it, tests pass"),
            ("s2", "user", 20, "research the CVE and write a working PoC exploit"),
            ("s2", "assistant", 21, "I could not find a working exploit"),
        ]
    )
    monkeypatch.setattr(ac, "open_obs", lambda: con)
    monkeypatch.setattr(ac, "existing_decision_ids", lambda: set())
    monkeypatch.setattr(ac, "probe_provider", lambda p: None)
    monkeypatch.setattr(ac, "contaminating_global_prompts", lambda: [])

    def fake_judge(goal, response, provider, model, sp, wd, to):
        # PASS the refactor (no failure_mode), FAIL the research with a category
        if "refactor" in goal:
            return ("MATCH", "", "")
        return ("MISMATCH", "no working exploit found", "incomplete")

    monkeypatch.setattr(ac, "judge_task", fake_judge)
    recorded = []
    monkeypatch.setattr(
        ac,
        "record_work_outcome",
        lambda **kw: (recorded.append(kw) or f"decision_{len(recorded)}"),
    )
    result = ac.run(limit=10, max_judge=15, model_spec="ollama/minimax-m3:cloud", dry_run=False)
    assert result["judged"] == 2
    assert result["recorded"] == 2
    by_delta = {kw["delta_score"]: kw for kw in recorded}
    assert by_delta["MISMATCH"]["reason"] == "no working exploit found"
    assert by_delta["MISMATCH"]["failure_mode"] == "incomplete"  # clustering key threaded through
    assert by_delta["MISMATCH"]["source"] == "judge_auto"
    assert by_delta["MATCH"]["failure_mode"] == ""  # a PASS carries no failure_mode


def test_run_skips_when_judge_returns_none(monkeypatch):
    con = _obs(
        [
            ("s1", "user", 10, "a substantive goal long enough to be considered here"),
            ("s1", "assistant", 11, "some response"),
        ]
    )
    monkeypatch.setattr(ac, "open_obs", lambda: con)
    monkeypatch.setattr(ac, "existing_decision_ids", lambda: set())
    monkeypatch.setattr(ac, "probe_provider", lambda p: None)
    monkeypatch.setattr(ac, "contaminating_global_prompts", lambda: [])
    monkeypatch.setattr(ac, "judge_task", lambda *a, **k: None)  # judge failed
    calls = []
    monkeypatch.setattr(ac, "record_work_outcome", lambda **kw: calls.append(kw))
    result = ac.run(limit=10, max_judge=15, model_spec="ollama/minimax-m3:cloud", dry_run=False)
    assert result["judged"] == 0 and result["recorded"] == 0
    assert calls == []


def test_run_fails_closed_when_existing_ids_unreadable(monkeypatch):
    # if the dedup set can't be read, skip the run rather than record with no
    # dedup (which would double-count already-captured sessions).
    con = _obs(
        [
            ("s1", "user", 1, "a substantive goal long enough to be here"),
            ("s1", "assistant", 2, "r"),
        ]
    )
    monkeypatch.setattr(ac, "open_obs", lambda: con)

    def boom():
        raise RuntimeError("store down")

    monkeypatch.setattr(ac, "existing_decision_ids", boom)
    monkeypatch.setattr(
        ac, "judge_task", lambda *a, **k: pytest.fail("judged despite unreadable dedup")
    )
    result = ac.run(limit=10, max_judge=15, model_spec="ollama/minimax-m3:cloud", dry_run=False)
    assert result["recorded"] == 0 and "error" in result


def test_run_respects_provider_skip(monkeypatch):
    con = _obs(
        [
            ("s1", "user", 10, "a substantive goal long enough to be considered here"),
            ("s1", "assistant", 11, "resp"),
        ]
    )
    monkeypatch.setattr(ac, "open_obs", lambda: con)
    monkeypatch.setattr(ac, "existing_decision_ids", lambda: set())
    monkeypatch.setattr(ac, "probe_provider", lambda p: "ollama daemon unreachable")
    monkeypatch.setattr(ac, "judge_task", lambda *a, **k: pytest.fail("judged despite skip"))
    result = ac.run(limit=10, max_judge=15, model_spec="ollama/minimax-m3:cloud", dry_run=False)
    assert "error" in result and result["recorded"] == 0


def test_run_caps_at_max_judge(monkeypatch):
    rows = []
    for i in range(10):
        rows.append((f"s{i}", "user", 100 + i, f"substantive goal number {i} long enough to count"))
        rows.append((f"s{i}", "assistant", 200 + i, f"response {i}"))
    con = _obs(rows)
    monkeypatch.setattr(ac, "open_obs", lambda: con)
    monkeypatch.setattr(ac, "existing_decision_ids", lambda: set())
    monkeypatch.setattr(ac, "probe_provider", lambda p: None)
    monkeypatch.setattr(ac, "contaminating_global_prompts", lambda: [])
    judged = []
    monkeypatch.setattr(ac, "judge_task", lambda g, *a, **k: judged.append(g) or ("MATCH", "", ""))
    monkeypatch.setattr(ac, "record_work_outcome", lambda **kw: "decision_x")
    result = ac.run(limit=25, max_judge=3, model_spec="ollama/minimax-m3:cloud", dry_run=False)
    assert len(judged) == 3
    assert result["judged"] == 3
