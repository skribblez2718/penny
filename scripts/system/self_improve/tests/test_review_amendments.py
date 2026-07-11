"""Tests for the amendment review CLI — the human approval/apply gate.

Focus: `list` surfaces AMENDMENTS NEEDING ACTION (PENDING to review, APPROVED to
apply) so approve-now-apply-later doesn't lose a proposal; resolved amendments
(APPLIED/REJECTED) drop off. _load_all is monkeypatched so these are hermetic.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import review_amendments as ra  # noqa: E402


def _rows(*statuses):
    """(drawer_id, record) pairs in the shape _load_all returns."""
    return [
        (
            f"d_{i}",
            {
                "amendment_id": f"amd_{st.lower()}_{i}",
                "status": st,
                "risk": "low",
                "target_file": ".pi/skills/plan/assets/prompts/piper.md",
                "changes": [{"rationale": "because reasons"}],
                "proposed_date": f"2026-07-0{i}",
            },
        )
        for i, st in enumerate(statuses, 1)
    ]


def test_list_default_shows_actionable_pending_and_approved(monkeypatch, capsys):
    monkeypatch.setattr(
        ra, "_load_all", lambda: _rows("PENDING", "APPROVED", "APPLIED", "REJECTED")
    )
    ra.cmd_list(show_all=False)
    out = capsys.readouterr().out
    assert "amd_pending_1" in out
    assert "amd_approved_2" in out  # stays visible — awaiting apply
    assert "amd_applied_3" not in out  # resolved → hidden
    assert "amd_rejected_4" not in out


def test_list_all_shows_every_status(monkeypatch, capsys):
    monkeypatch.setattr(
        ra, "_load_all", lambda: _rows("PENDING", "APPROVED", "APPLIED", "REJECTED")
    )
    ra.cmd_list(show_all=True)
    out = capsys.readouterr().out
    for st in ("pending", "approved", "applied", "rejected"):
        assert f"amd_{st}_" in out


def test_list_empty_when_only_resolved(monkeypatch, capsys):
    monkeypatch.setattr(ra, "_load_all", lambda: _rows("APPLIED", "REJECTED"))
    ra.cmd_list(show_all=False)
    assert "no amendments to act on" in capsys.readouterr().out


# --- approve/reject lifecycle (hermetic: monkeypatch _find + _rewrite) --------


def _concrete(status="PENDING"):
    return {
        "amendment_id": "amd_x",
        "status": status,
        "changes": [{"action": "MODIFY", "old_text": "a", "new_text": "b", "rationale": "r"}],
        "target_file": ".pi/skills/plan/assets/prompts/piper.md",
    }


def test_reject_allowed_from_approved(monkeypatch):
    # An approved-but-unappliable amendment must have a terminal exit — otherwise
    # it re-surfaces in the session brief forever.
    monkeypatch.setattr(ra, "_find", lambda i: ("d1", _concrete("APPROVED")))
    captured = {}
    monkeypatch.setattr(ra, "_rewrite", lambda d, o, u: captured.update(u))
    assert ra.cmd_reject("amd_x") == 0
    assert captured["status"] == "REJECTED"


def test_approve_refuses_empty_diff(monkeypatch):
    rec = {
        "amendment_id": "amd_e",
        "status": "PENDING",
        "changes": [{"action": "MODIFY", "old_text": "", "new_text": ""}],
        "target_file": "f",
    }
    monkeypatch.setattr(ra, "_find", lambda i: ("d1", rec))

    def _boom(*_a):
        raise AssertionError("must not rewrite an empty-diff amendment to APPROVED")

    monkeypatch.setattr(ra, "_rewrite", _boom)
    import pytest

    with pytest.raises(SystemExit):
        ra.cmd_approve("amd_e")


def test_approve_allows_concrete_diff(monkeypatch):
    monkeypatch.setattr(ra, "_find", lambda i: ("d1", _concrete("PENDING")))
    captured = {}
    monkeypatch.setattr(ra, "_rewrite", lambda d, o, u: captured.update(u))
    assert ra.cmd_approve("amd_x") == 0
    assert captured["status"] == "APPROVED"
