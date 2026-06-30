# renderer tests — TDD
"""Render digest JSON to markdown for human presentation."""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from renderer import render_digest_markdown  # noqa: E402


class TestRenderDigestMarkdown:
    """Digest → Markdown formatting."""

    def test_basic_render(self):
        digest = {
            "digest_id": "digest_2026-04-21",
            "week_start": "2026-04-21",
            "week_end": "2026-04-28",
            "session_ids": ["s1", "s2"],
            "summary": {"sessions": 3, "decisions": 5, "actions_taken": 12},
            "outcomes": {"MATCH": 3, "PARTIAL": 1, "MISMATCH": 1, "unevaluated": 0},
            "confidence": {"CERTAIN": 2, "PROBABLE": 2, "POSSIBLE": 1, "UNCERTAIN": 0},
            "attention_flags": [],
            "amendments_summary": {"proposed": 1, "approved": 0, "rejected": 0, "pending": 1},
            "signals_summary": {"critical_pending": 0, "info_pending": 2},
            "recommendations": ["Review MISMATCH in coding"],
        }
        md = render_digest_markdown(digest)
        assert "# Penny Weekly Digest" in md
        assert "Week of 2026-04-21" in md
        assert "Sessions: 3" in md
        assert "MATCH: 3" in md
        assert "Correlation IDs" in md
        assert "s1" in md and "s2" in md

    def test_attention_flags_rendered(self):
        digest = {
            "week_start": "2026-04-21",
            "outcomes": {"MATCH": 0, "PARTIAL": 0, "MISMATCH": 2, "unevaluated": 0},
            "confidence": {},
            "attention_flags": [
                {"type": "MISMATCH", "severity": "HIGH", "description": "2 MISMATCH in coding", "session_id": "s1", "evidence": ["d1", "d2"]}
            ],
            "amendments_summary": {"proposed": 0, "approved": 0, "rejected": 0, "pending": 0},
            "signals_summary": {"critical_pending": 0, "info_pending": 0},
            "recommendations": ["Review MISMATCH in coding (session: s1)"],
            "session_ids": ["s1"],
            "summary": {"sessions": 1, "decisions": 2, "actions_taken": 2},
        }
        md = render_digest_markdown(digest)
        assert "⚠️" in md or "Attention" in md
        assert "MISMATCH in coding" in md
        assert "s1" in md

    def test_critical_signals_rendered(self):
        digest = {
            "week_start": "2026-04-21",
            "outcomes": {"MATCH": 1, "PARTIAL": 0, "MISMATCH": 0, "unevaluated": 0},
            "confidence": {},
            "attention_flags": [
                {"type": "CRITICAL_SIGNAL", "severity": "HIGH", "description": "High drift detected", "session_id": "", "evidence": ["sig1"]}
            ],
            "amendments_summary": {"proposed": 0, "approved": 0, "rejected": 0, "pending": 0},
            "signals_summary": {"critical_pending": 1, "info_pending": 0},
            "recommendations": ["Address 1 critical pending signal(s)"],
            "session_ids": [],
            "summary": {"sessions": 1, "decisions": 1, "actions_taken": 1},
        }
        md = render_digest_markdown(digest)
        assert "High drift detected" in md

    def test_empty_week_render(self):
        digest = {
            "week_start": "2026-04-21",
            "outcomes": {"MATCH": 0, "PARTIAL": 0, "MISMATCH": 0, "unevaluated": 0},
            "confidence": {},
            "attention_flags": [],
            "amendments_summary": {"proposed": 0, "approved": 0, "rejected": 0, "pending": 0},
            "signals_summary": {"critical_pending": 0, "info_pending": 0},
            "recommendations": [],
            "session_ids": [],
            "summary": {"sessions": 0, "decisions": 0, "actions_taken": 0},
        }
        md = render_digest_markdown(digest)
        assert "No activity" in md or "Sessions: 0" in md

    def test_percentages_calculated(self):
        digest = {
            "week_start": "2026-04-21",
            "outcomes": {"MATCH": 1, "PARTIAL": 1, "MISMATCH": 1, "unevaluated": 0},
            "confidence": {},
            "attention_flags": [],
            "amendments_summary": {"proposed": 0, "approved": 0, "rejected": 0, "pending": 0},
            "signals_summary": {"critical_pending": 0, "info_pending": 0},
            "recommendations": [],
            "session_ids": [],
            "summary": {"sessions": 1, "decisions": 3, "actions_taken": 3},
        }
        md = render_digest_markdown(digest)
        # 1 of 3 = 33.3%, rounded to 33%
        assert "33%" in md or "33.3%" in md
