# Integration tests — digest pipeline
"""Multi-module integration: generator → renderer, generator → storage."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from generator import build_digest_json  # noqa: E402
from renderer import render_digest_markdown  # noqa: E402
from storage import store_digest  # noqa: E402


class TestGeneratorToRendererPipeline:
    """Digest JSON renders to complete markdown."""

    def test_full_digest_renders_all_sections(self):
        digest = build_digest_json(
            outcomes=[
                {
                    "outcome": "MATCH",
                    "domain": "coding",
                    "confidence_at_action": "PROBABLE",
                    "session_id": "s1",
                },
                {
                    "outcome": "MISMATCH",
                    "domain": "coding",
                    "confidence_at_action": "POSSIBLE",
                    "session_id": "s1",
                },
                {
                    "outcome": "MISMATCH",
                    "domain": "coding",
                    "confidence_at_action": "POSSIBLE",
                    "session_id": "s1",
                },
            ],
            diary=[],
            week_start="2026-04-21",
            week_end="2026-04-28",
            signals=[
                {
                    "priority": "CRITICAL",
                    "title": "High drift",
                    "status": "PENDING",
                    "signal_id": "sig1",
                },
            ],
            amendments={"proposed": 1, "approved": 0, "rejected": 0, "pending": 1},
        )
        md = render_digest_markdown(digest)
        assert "# Penny Weekly Digest" in md
        assert "Week of 2026-04-21" in md
        assert "Sessions:" in md
        assert "MATCH:" in md
        assert "MISMATCH:" in md
        assert "⚠️" in md or "Attention" in md
        assert "High drift" in md
        assert "Correlation IDs" in md
        assert "s1" in md

    def test_empty_digest_renders_gracefully(self):
        digest = build_digest_json([], [], "2026-04-21", "2026-04-28")
        md = render_digest_markdown(digest)
        assert "Sessions: 0" in md
        assert "No activity" in md or "MATCH: 0" in md

    def test_session_ids_present_in_markdown(self):
        digest = build_digest_json(
            outcomes=[{"outcome": "MATCH", "session_id": "session_abc_123"}],
            diary=[],
            week_start="2026-04-21",
            week_end="2026-04-28",
        )
        md = render_digest_markdown(digest)
        assert "session_abc_123" in md


class TestGeneratorToStoragePipeline:
    """Digest JSON stores and retrieves with fidelity."""

    def test_store_and_retrieve_round_trip(self):
        digest = build_digest_json(
            outcomes=[{"outcome": "MATCH", "session_id": "s1"}],
            diary=[],
            week_start="2026-04-21",
            week_end="2026-04-28",
        )
        written = []

        def mock_writer(data):
            written.append(data)
            return {"success": True, "drawer_id": "drawer_123"}

        store_result = store_digest(digest, writer=mock_writer)
        assert store_result["success"] is True
        assert len(written) == 1

        # Verify stored content is JSON
        import json

        content = written[0].get("content", "")
        assert "digest_2026-04-21" in content
        lines = content.splitlines()
        json_text = "\n".join(lines[1:])
        parsed = json.loads(json_text)
        assert parsed["week_start"] == "2026-04-21"

    def test_storage_with_correlation_ids(self):
        digest = build_digest_json(
            outcomes=[
                {"outcome": "MATCH", "session_id": "obs_session_001"},
                {"outcome": "MATCH", "session_id": "obs_session_002"},
            ],
            diary=[],
            week_start="2026-04-21",
            week_end="2026-04-28",
        )
        assert "obs_session_001" in digest["session_ids"]
        assert "obs_session_002" in digest["session_ids"]
