# storage tests — TDD
"""Store and retrieve digest JSON in mempalace."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from storage import store_digest, get_digest_for_week  # noqa: E402


class TestStoreDigest:
    """Digest persistence in mempalace."""

    def test_store_digest_writes_json(self):
        digest = {
            "digest_id": "digest_2026-04-21",
            "week_start": "2026-04-21",
            "week_end": "2026-04-28",
            "session_ids": ["s1"],
            "summary": {"sessions": 1, "decisions": 1, "actions_taken": 1},
            "outcomes": {"MATCH": 1, "PARTIAL": 0, "MISMATCH": 0, "unevaluated": 0},
            "confidence": {"CERTAIN": 1, "PROBABLE": 0, "POSSIBLE": 0, "UNCERTAIN": 0},
            "attention_flags": [],
            "amendments_summary": {"proposed": 0, "approved": 0, "rejected": 0, "pending": 0},
            "signals_summary": {"critical_pending": 0, "info_pending": 0},
            "recommendations": [],
        }
        # Use mock writer to avoid actual mempalace calls in tests
        written = []

        def mock_writer(data):
            written.append(
                {"wing": data.get("wing"), "room": data.get("room"), "content": data.get("content")}
            )
            return {"success": True, "drawer_id": "drawer_test_123"}

        result = store_digest(digest, writer=mock_writer)
        assert result["success"] is True
        assert len(written) == 1
        assert written[0]["wing"] == "penny"
        assert written[0]["room"] == "digests"
        # Verify content is valid JSON (skip digest_id header line)
        content_lines = written[0]["content"].splitlines()
        json_text = "\n".join(content_lines[1:])
        import json

        parsed = json.loads(json_text)
        assert parsed["digest_id"] == "digest_2026-04-21"

    def test_store_digest_invalid_input(self):
        result = store_digest(None)
        assert result["success"] is False
        assert "invalid" in result.get("error", "").lower()


class TestGetDigestForWeek:
    """Retrieval by week."""

    def test_get_existing_digest(self):
        expected_digest = {
            "digest_id": "digest_2026-04-21",
            "week_start": "2026-04-21",
            "week_end": "2026-04-28",
        }

        def mock_search(query_dict):
            query = query_dict.get("query", "")
            if "2026-04-21" in query:
                return {
                    "results": [
                        {
                            "text": "digest_id: digest_2026-04-21\n"
                            + str(expected_digest).replace("'", '"'),
                        }
                    ]
                }
            return {"results": []}

        result = get_digest_for_week("2026-04-21", searcher=mock_search)
        assert result is not None
        assert result.get("digest_id") == "digest_2026-04-21"

    def test_get_nonexistent_digest(self):
        def mock_search(query_dict):
            return {"results": []}

        result = get_digest_for_week("2026-01-01", searcher=mock_search)
        assert result is None

    def test_get_digest_malformed_result(self):
        def mock_search(query_dict):
            return {"results": [{"text": "not valid json"}]}

        result = get_digest_for_week("2026-04-21", searcher=mock_search)
        assert result is None  # gracefully handle malformed data
