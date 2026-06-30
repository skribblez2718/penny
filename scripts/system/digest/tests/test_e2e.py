# E2E tests — digest full flow
"""End-to-end: outcomes → digest → render → present / store → retrieve."""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from generator import build_digest_json  # noqa: E402
from renderer import render_digest_markdown  # noqa: E402
from storage import store_digest  # noqa: E402


class TestFullDigestLifecycle:
    """Complete lifecycle from data sources to presentation."""

    def test_week_with_mismatch_produces_attention_digest(self):
        digest = build_digest_json(
            outcomes=[
                {"outcome": "MATCH", "domain": "coding", "session_id": "s1"},
                {"outcome": "MISMATCH", "domain": "coding", "reason": "wrong file", "session_id": "s1", "decision_id": "d1"},
                {"outcome": "MISMATCH", "domain": "coding", "reason": "wrong path", "session_id": "s1", "decision_id": "d2"},
            ],
            diary=[],
            week_start="2026-04-21",
            week_end="2026-04-28",
        )
        assert len(digest["attention_flags"]) == 1
        assert digest["attention_flags"][0]["type"] == "MISMATCH"

        md = render_digest_markdown(digest)
        assert "⚠️" in md or "Attention" in md
        assert "wrong file" in md or "MISMATCH" in md
        assert "session_" in md.lower() or "s1" in md

    def test_week_with_critical_signal_produces_attention_digest(self):
        digest = build_digest_json(
            outcomes=[{"outcome": "MATCH", "session_id": "s1"}],
            diary=[],
            week_start="2026-04-21",
            week_end="2026-04-28",
            signals=[{"priority": "CRITICAL", "title": "Drift detected", "status": "PENDING", "signal_id": "sig1"}],
        )
        assert len(digest["attention_flags"]) == 1
        assert digest["attention_flags"][0]["type"] == "CRITICAL_SIGNAL"

    def test_store_retrieve_render_round_trip(self):
        digest = build_digest_json(
            outcomes=[{"outcome": "MATCH", "session_id": "s1"}],
            diary=[],
            week_start="2026-04-21",
            week_end="2026-04-28",
        )
        written_content = []

        def mock_writer(data):
            written_content.append(data.get("content", ""))
            return {"success": True, "drawer_id": "drawer_abc"}

        store_result = store_digest(digest, writer=mock_writer)
        assert store_result["success"] is True

        # Simulate retrieval by parsing what was stored
        import json
        lines = written_content[0].splitlines()
        json_text = "\n".join(lines[1:])
        retrieved = json.loads(json_text)

        assert retrieved["week_start"] == "2026-04-21"
        assert retrieved["session_ids"] == ["s1"]

        # Render retrieved
        md = render_digest_markdown(retrieved)
        assert "# Penny Weekly Digest" in md
        assert "s1" in md

    def test_empty_week_produces_zero_digest(self):
        digest = build_digest_json([], [], "2026-04-21", "2026-04-28")
        assert digest["summary"]["sessions"] == 0
        assert digest["summary"]["decisions"] == 0
        assert digest["outcomes"]["MATCH"] == 0
        assert digest["attention_flags"] == []

        md = render_digest_markdown(digest)
        assert "Sessions: 0" in md
        assert "MATCH: 0" in md

    def test_multiple_sessions_deduplicated(self):
        digest = build_digest_json(
            outcomes=[
                {"outcome": "MATCH", "session_id": "alpha"},
                {"outcome": "MATCH", "session_id": "alpha"},
                {"outcome": "PARTIAL", "session_id": "beta"},
            ],
            diary=[],
            week_start="2026-04-21",
            week_end="2026-04-28",
        )
        assert sorted(digest["session_ids"]) == ["alpha", "beta"]
        assert digest["summary"]["decisions"] == 3
