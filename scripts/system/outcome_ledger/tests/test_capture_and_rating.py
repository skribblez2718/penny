"""Unit tests for source-agnostic outcome capture + the human quick-rating source.

Hermetic: the memory bridge is injected (no live store); observability reads use
an in-memory sqlite matching the real entries schema.
"""

import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest  # noqa: E402

from outcome_ledger import capture  # noqa: E402
from outcome_ledger import rate_recent  # noqa: E402

# ── capture.record_work_outcome ──────────────────────────────────────────────


def _fake_writer(calls):
    def writer(payload):
        calls.append(payload)
        return {"success": True, "drawer_id": "d1"}

    return writer


def test_infer_domain():
    assert capture.infer_domain("refactor the auth code and add a test") == "coding"
    assert capture.infer_domain("research the CVE and find a PoC") == "research"
    assert capture.infer_domain("plan the migration") == "planning"
    assert capture.infer_domain("draft an email reply") == "communication"
    assert capture.infer_domain("water the plants") == "other"


# ── #11: model domain classifier (keyword as resilient fallback) ─────────────


def _domain_stream(text: str) -> str:
    """A --mode json stdout with one assistant message_end carrying `text`."""
    msg = {"type": "message_end", "message": {"role": "assistant", "stopReason": "stop",
           "content": [{"type": "text", "text": text}]}}
    return json.dumps({"type": "agent_start"}) + "\n" + json.dumps(msg)


def _fake_runner(stdout="", *, returncode=0, raise_exc=None):
    class _Proc:
        pass

    def run(cmd, **kwargs):
        if raise_exc is not None:
            raise raise_exc
        p = _Proc()
        p.stdout, p.stderr, p.returncode = stdout, "", returncode
        return p

    return run


def test_normalize_domain():
    assert capture.normalize_domain("Coding") == "coding"
    assert capture.normalize_domain("  research ") == "research"
    assert capture.normalize_domain("astrology") == "other"   # unknown -> other
    assert capture.normalize_domain("") == ""                  # empty stays empty


def test_extract_domain_json_bareword_and_none():
    assert capture._extract_domain('{"domain": "coding"}') == "coding"
    assert capture._extract_domain("The domain here is research.") == "research"
    assert capture._extract_domain('{"domain": "astrology"}') == "other"  # normalized
    assert capture._extract_domain("no recognizable label") is None


def test_classify_domain_gate_off_uses_keyword(monkeypatch):
    monkeypatch.delenv(capture.DOMAIN_MODEL_ENV, raising=False)
    # gate off: keyword only; a runner would never be consulted
    assert capture.classify_domain("refactor the auth code") == "coding"


def test_classify_domain_model_label_wins(monkeypatch):
    monkeypatch.setenv(capture.DOMAIN_MODEL_ENV, "anthropic/haiku")
    runner = _fake_runner(_domain_stream('{"domain": "planning"}'))
    # keywords say 'coding'; the model says 'planning' -> model wins
    assert capture.classify_domain("refactor the code", runner=runner) == "planning"


def test_classify_domain_falls_back_on_model_failure(monkeypatch):
    monkeypatch.setenv(capture.DOMAIN_MODEL_ENV, "anthropic/haiku")
    runner = _fake_runner(raise_exc=OSError("boom"))
    assert capture.classify_domain("refactor the code", runner=runner) == "coding"


def test_classify_domain_falls_back_on_unrecognized_output(monkeypatch):
    monkeypatch.setenv(capture.DOMAIN_MODEL_ENV, "anthropic/haiku")
    runner = _fake_runner(_domain_stream("I cannot tell."))  # no menu label
    assert capture.classify_domain("plan the migration", runner=runner) == "planning"


def test_classify_domain_falls_back_on_error_stop(monkeypatch):
    monkeypatch.setenv(capture.DOMAIN_MODEL_ENV, "anthropic/haiku")
    err = json.dumps({"type": "message_end", "message": {"role": "assistant",
                      "stopReason": "error", "content": []}})
    runner = _fake_runner(err)
    assert capture.classify_domain("research the CVE", runner=runner) == "research"


def test_classify_domain_falls_back_on_nonzero_exit(monkeypatch):
    monkeypatch.setenv(capture.DOMAIN_MODEL_ENV, "anthropic/haiku")
    runner = _fake_runner(_domain_stream('{"domain": "planning"}'), returncode=1)
    # non-zero exit -> treated as failure -> keyword ('coding')
    assert capture.classify_domain("refactor the code", runner=runner) == "coding"


def test_default_decision_id_is_stable_and_session_specific():
    a = capture.default_decision_id("s1", "do the thing")
    assert a == capture.default_decision_id("s1", "do the thing")
    assert a != capture.default_decision_id("s2", "do the thing")
    assert a.startswith("decision_")


def test_build_content_has_header_and_reason():
    rec = {
        "decision_id": "decision_abc",
        "delta_score": "MISMATCH",
        "domain": "coding",
        "session_id": "s1",
        "confidence_at_action": "PROBABLE",
        "timestamp": "2026-07-07T00:00:00Z",
        "reason": "assumed uv not pip",
    }
    content = capture.build_content(rec)
    header, body = content.split("\n", 1)
    assert header.startswith("decision_id: decision_abc | delta_score: MISMATCH")
    parsed = json.loads(body)
    assert parsed["reason"] == "assumed uv not pip"


def test_record_work_outcome_writes_and_carries_reason():
    calls = []
    did = capture.record_work_outcome(
        goal="refactor the auth module",
        action_taken="edited session_store.py",
        delta_score="MISMATCH",
        confidence="PROBABLE",
        reason="assumed uv when project uses pip",
        session_id="s1",
        source="human_rating",
        writer=_fake_writer(calls),
    )
    assert did and did.startswith("decision_")
    assert len(calls) == 1
    body = json.loads(calls[0]["content"].split("\n", 1)[1])
    assert body["delta_score"] == "MISMATCH"
    assert body["outcome"] == "MISMATCH"  # alias present
    assert body["reason"] == "assumed uv when project uses pip"
    assert body["domain"] == "coding"  # inferred
    assert body["source"] == "human_rating"


def test_record_work_outcome_carries_and_normalizes_failure_mode():
    calls = []
    capture.record_work_outcome(
        goal="refactor the auth module",
        action_taken="a",
        delta_score="MISMATCH",
        reason="assumed uv when project uses pip",
        failure_mode="missing_constraint",
        session_id="s1",
        writer=_fake_writer(calls),
    )
    body = json.loads(calls[0]["content"].split("\n", 1)[1])
    assert body["failure_mode"] == "missing_constraint"  # the clustering key

    # an off-vocab failure_mode buckets to "other" (never raises)
    calls2 = []
    capture.record_work_outcome(
        goal="g",
        action_taken="a",
        delta_score="MISMATCH",
        failure_mode="garbled nonsense",
        session_id="s2",
        writer=_fake_writer(calls2),
    )
    assert json.loads(calls2[0]["content"].split("\n", 1)[1])["failure_mode"] == "other"

    # a clean MATCH leaves it empty
    calls3 = []
    capture.record_work_outcome(
        goal="g", action_taken="a", delta_score="MATCH", session_id="s3", writer=_fake_writer(calls3)
    )
    assert json.loads(calls3[0]["content"].split("\n", 1)[1])["failure_mode"] == ""


def test_record_work_outcome_dedups_via_existing_ids():
    calls = []
    seen = set()
    did1 = capture.record_work_outcome(
        goal="g",
        action_taken="a",
        delta_score="MATCH",
        session_id="s1",
        existing_ids=seen,
        writer=_fake_writer(calls),
    )
    did2 = capture.record_work_outcome(
        goal="g",
        action_taken="a",
        delta_score="MATCH",
        session_id="s1",
        existing_ids=seen,
        writer=_fake_writer(calls),
    )
    assert did1 is not None
    assert did2 is None  # duplicate
    assert len(calls) == 1


def test_record_work_outcome_validates_inputs():
    with pytest.raises(ValueError):
        capture.record_work_outcome(
            goal="g", action_taken="a", delta_score="GOOD", writer=_fake_writer([])
        )
    with pytest.raises(ValueError):
        capture.record_work_outcome(
            goal="g",
            action_taken="a",
            delta_score="MATCH",
            confidence="MAYBE",
            writer=_fake_writer([]),
        )


def test_record_work_outcome_returns_none_on_writer_failure():
    def bad_writer(_):
        return {"success": False, "reason": "duplicate"}

    did = capture.record_work_outcome(
        goal="g", action_taken="a", delta_score="MATCH", writer=bad_writer
    )
    assert did is None


def test_existing_decision_ids_parses_header_and_json_forms():
    header_drawer = {
        "content": "decision_id: decision_h1 | delta_score: MATCH | domain: coding\n{...}"
    }
    json_drawer = {"content": json.dumps({"decision_id": "decision_j1", "delta_score": "MATCH"})}
    ids = capture.existing_decision_ids(reader=lambda: [header_drawer, json_drawer])
    assert ids == {"decision_h1", "decision_j1"}


def _outcome_drawer(did, delta, source, drawer_id="d1", goal="g", action="a", reason=""):
    body = json.dumps(
        {
            "decision_id": did,
            "delta_score": delta,
            "outcome": delta,
            "expected_outcome": goal,
            "action_taken": action,
            "reason": reason,
            "source": source,
            "domain": "coding",
            "session_id": "s",
            "confidence_at_action": "",
            "timestamp": "2026-07-07T00:00:00Z",
        }
    )
    header = f"decision_id: {did} | delta_score: {delta}"
    return {"id": drawer_id, "content": header + "\n" + body}


def test_parse_outcome_drawer_and_load_by_source():
    drawers = [
        _outcome_drawer("d_auto", "MATCH", "judge_auto", drawer_id="da"),
        _outcome_drawer("d_human", "MISMATCH", "human_rating", drawer_id="dh"),
    ]
    autos = capture.load_outcomes_by_source("judge_auto", reader=lambda: drawers)
    assert len(autos) == 1
    assert autos[0]["decision_id"] == "d_auto"
    assert autos[0]["_drawer_id"] == "da"


def test_override_outcome_flips_verdict_and_deletes_old():
    record = capture.parse_outcome_drawer(
        _outcome_drawer("d_auto", "MATCH", "judge_auto", drawer_id="da")
    )
    writes, deletes = [], []
    ok = capture.override_outcome(
        record,
        "MISMATCH",
        user_feedback="human-override",
        reason="actually wrong",
        writer=lambda p: writes.append(p) or {"success": True, "drawer_id": "new"},
        deleter=lambda did: deletes.append(did),
    )
    assert ok
    assert deletes == ["da"]  # old drawer removed
    body = json.loads(writes[0]["content"].split("\n", 1)[1])
    assert body["delta_score"] == "MISMATCH"
    assert body["outcome"] == "MISMATCH"
    assert body["source"] == "human_override"
    assert body["reason"] == "actually wrong"
    assert "_drawer_id" not in body  # internal field stripped before write


def test_override_outcome_rejects_bad_delta():
    record = capture.parse_outcome_drawer(_outcome_drawer("d", "MATCH", "judge_auto"))
    with pytest.raises(ValueError):
        capture.override_outcome(record, "NOPE", user_feedback="x", writer=lambda p: {})


# ── rate_recent (observability source) ───────────────────────────────────────


def _obs_with_entries(rows):
    con = sqlite3.connect(":memory:")
    con.execute(
        "CREATE TABLE entries (id INTEGER PRIMARY KEY, session_id TEXT, "
        "event_type TEXT, role TEXT, timestamp INTEGER, data JSON)"
    )
    for sid, role, ts, text in rows:
        data = json.dumps({"content": [{"type": "text", "text": text}]})
        con.execute(
            "INSERT INTO entries (session_id, role, timestamp, data) VALUES (?,?,?,?)",
            (sid, role, ts, data),
        )
    con.commit()
    return con


def test_extract_text_handles_list_and_string_content():
    assert rate_recent._extract_text(json.dumps({"content": "hello"})) == "hello"
    assert (
        rate_recent._extract_text(json.dumps({"content": [{"type": "text", "text": "hi there"}]}))
        == "hi there"
    )
    assert rate_recent._extract_text("not json") == ""


def test_recent_session_goals_uses_first_user_prompt_per_session():
    con = _obs_with_entries(
        [
            ("s1", "user", 100, "refactor the auth module thoroughly please"),
            ("s1", "assistant", 101, "done"),
            ("s1", "user", 102, "now add tests"),
            ("s2", "user", 200, "research the CVE and locate a public PoC exploit"),
        ]
    )
    goals = rate_recent.recent_session_goals(con, limit=10)
    # most recent session first (s2 ts=200 > s1 ts=100); each session's EARLIEST
    # user prompt is the goal (s1 → "refactor...", not "now add tests")
    assert goals[0][0] == "s2"
    assert "research the CVE" in goals[0][1]
    assert goals[1][0] == "s1"
    assert goals[1][1].startswith("refactor the auth module")


def test_pending_sessions_filters_short_and_already_rated():
    goals = [
        ("s1", "refactor the auth module thoroughly please", 100),
        ("s2", "hi", 90),  # too short
        ("s3", "research the CVE and locate a public PoC exploit", 80),
    ]
    existing = {
        capture.default_decision_id("s3", "research the CVE and locate a public PoC exploit")
    }
    pending = rate_recent.pending_sessions(goals, existing)
    ids = [p[0] for p in pending]
    assert ids == ["s1"]  # s2 too short, s3 already rated


def test_pending_sessions_empty_when_all_rated():
    goals = [("s1", "a substantive goal that is long enough to count here", 1)]
    existing = {
        capture.default_decision_id("s1", "a substantive goal that is long enough to count here")
    }
    assert rate_recent.pending_sessions(goals, existing) == []


# ── args-based rating interface (what Penny drives in-conversation, no stdin) ──


def test_normalize_verdict_accepts_keys_and_words():
    assert rate_recent._normalize_verdict("m") == "MATCH"
    assert rate_recent._normalize_verdict("MISMATCH") == "MISMATCH"
    assert rate_recent._normalize_verdict("Partial") == "PARTIAL"
    assert rate_recent._normalize_verdict("banana") is None
    assert rate_recent._normalize_verdict("") is None


def test_goal_for_session_returns_canonical_first_user_prompt():
    con = _obs_with_entries(
        [
            ("s1", "user", 1, "refactor the auth module thoroughly"),
            ("s1", "user", 2, "now add tests"),
        ]
    )
    assert rate_recent.goal_for_session(con, "s1") == "refactor the auth module thoroughly"
    assert rate_recent.goal_for_session(con, "nope") == ""


def test_record_rating_from_args_carries_verdict_reason_failure_mode():
    con = _obs_with_entries([("s1", "user", 1, "refactor the auth module thoroughly please")])
    calls = []
    did = rate_recent.record_rating(
        con,
        "s1",
        "mismatch",
        reason="assumed uv not pip",
        failure_mode="missing_constraint",
        writer=_fake_writer(calls),
    )
    assert did and did.startswith("decision_")
    body = json.loads(calls[0]["content"].split("\n", 1)[1])
    assert body["delta_score"] == "MISMATCH"
    assert body["failure_mode"] == "missing_constraint"
    assert body["reason"] == "assumed uv not pip"
    assert body["source"] == "human_rating"
    # canonical goal was looked up (id stable, dedups with the judge's capture)
    assert body["decision_id"] == capture.default_decision_id(
        "s1", "refactor the auth module thoroughly please"
    )


def test_record_rating_rejects_bad_verdict_without_writing():
    con = _obs_with_entries([("s1", "user", 1, "a substantive goal long enough to count here")])
    calls = []
    assert rate_recent.record_rating(con, "s1", "banana", writer=_fake_writer(calls)) is None
    assert calls == []


def test_list_unrated_returns_goal_and_response_for_presentation():
    con = _obs_with_entries(
        [
            ("s1", "user", 1, "refactor the auth module thoroughly please"),
            ("s1", "assistant", 2, "done, tests pass"),
        ]
    )
    items = rate_recent.list_unrated(con, set(), 10)
    assert len(items) == 1
    assert items[0]["session_id"] == "s1"
    assert "refactor" in items[0]["goal"]
    assert items[0]["response"] == "done, tests pass"
    assert items[0]["domain"] == "coding"
