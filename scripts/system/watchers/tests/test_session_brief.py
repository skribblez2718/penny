"""Tests for the session-memory brief that session_start_checker writes for
injection into the system prompt."""

import json

# sys.path setup lives in conftest.py (watchers dir + hermetic obs URL).
import session_start_checker as ssc


def test_brief_is_wrapped_and_bounded():
    brief = ssc.build_session_brief(
        pending={"critical": [{"title": "High MISMATCH rate"}], "info": []},
        amendments=[],
        digest=None,
        diary=[{"date": "2026-07-04", "content": "x" * 5000}],
        mismatches=[],
    )
    assert brief.startswith("<session_memory>")
    assert brief.rstrip().endswith("</session_memory>")
    # Long diary content is truncated into the brief.
    diary_line = [ln for ln in brief.splitlines() if ln.startswith("- (2026-07-04)")][0]
    assert len(diary_line) < 300


def test_brief_collapses_newlines_in_freeform():
    brief = ssc.build_session_brief(
        pending={"critical": [], "info": []},
        amendments=[],
        digest=None,
        diary=[{"date": "d", "content": "line1\nline2"}],
        mismatches=[{"domain": "coding", "action_taken": "did\na\nthing"}],
    )
    for line in brief.splitlines():
        # No brief line should contain a raw embedded newline beyond the split.
        assert "\n" not in line


def test_write_session_brief(tmp_path):
    target = tmp_path / "nested" / "SESSION_BRIEF.md"
    assert ssc.write_session_brief("hello", target) is True
    assert target.read_text() == "hello"


def test_get_recent_mismatches_parses_header_plus_json(monkeypatch):
    body = json.dumps({"outcome": "MISMATCH", "domain": "coding", "action_taken": "broke it"})
    hit_text = "decision_id: r1 | delta_score: MISMATCH\n" + body
    match_text = "decision_id: r2 | delta_score: MATCH\n" + json.dumps(
        {"outcome": "MATCH", "domain": "coding"}
    )

    def fake_search(_params):
        return {"results": [{"text": match_text}, {"text": hit_text}]}

    monkeypatch.setattr(ssc, "tool_smart_search", fake_search)
    out = ssc.get_recent_mismatches(limit=3)
    assert len(out) == 1
    assert out[0]["domain"] == "coding"
    assert out[0]["action_taken"] == "broke it"


def _amend_hit(aid, status, day):
    body = {
        "amendment_id": aid,
        "status": status,
        "target_file": ".pi/skills/plan/assets/prompts/piper.md",
        "risk": "low",
        "proposed_date": f"2026-07-0{day}",
    }
    return {"text": f"amendment_id: {aid}\n" + json.dumps(body)}


def test_get_pending_amendments_surfaces_pending_and_approved(monkeypatch):
    # APPROVED stays surfaced (awaiting apply) so approve-now-apply-later isn't
    # lost; resolved (APPLIED/REJECTED) are excluded.
    def fake_search(_params):
        return {
            "results": [
                _amend_hit("a_pending", "PENDING", 1),
                _amend_hit("a_approved", "APPROVED", 2),
                _amend_hit("a_applied", "APPLIED", 3),
                _amend_hit("a_rejected", "REJECTED", 4),
            ]
        }

    monkeypatch.setattr(ssc, "tool_smart_search", fake_search)
    ids = {a["amendment_id"] for a in ssc.get_pending_amendments(limit=10)}
    assert ids == {"a_pending", "a_approved"}


def test_brief_labels_amendment_next_action():
    brief = ssc.format_signal_presentation(
        {"critical": [], "info": []},
        amendments=[
            {"amendment_id": "a1", "status": "PENDING", "target_file": "x/p.md", "risk": "low"},
            {"amendment_id": "a2", "status": "APPROVED", "target_file": "y/q.md", "risk": "low"},
        ],
        digest=None,
    )
    assert "a1** [review]" in brief  # pending → review
    assert "a2** [apply]" in brief   # approved → apply
