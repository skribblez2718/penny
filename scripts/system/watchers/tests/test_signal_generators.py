"""
Tests for signal generation functions.

The outcome-mining watchers read the FULL ledger via tool_list_drawers (not
sampled smart_search summaries), so these tests feed drawer-shaped records:
{"drawers": [{"content": ..., "filed_at": ...}], "success": True}.
"""

import json
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

# sys.path setup lives in conftest.py (watchers dir + hermetic obs URL);
# signal_generators itself puts the bridge dir on sys.path at import.
from signal_generators import (
    generate_mismatch_rate_signal,
    generate_confidence_trend_signal,
    generate_mempalace_growth_signal,
    generate_task_staleness_signal,
    write_signal,
    _load_outcome_records,
    _parse_outcome_text,
    _parse_dt,
    _parse_confidence,
    _signal_id,
)


# Dynamic timestamps so tests never go stale due to time-window filtering
def _iso_days_ago(days: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


_RECENT = _iso_days_ago(1)
_OLDER = _iso_days_ago(3)


def _outcome_drawer(
    outcome: str,
    decision_id: str = "d1",
    confidence: str = "",
    timestamp: str = _RECENT,
) -> dict:
    """A drawer shaped like the engine outcome writer's output."""
    body = {
        "decision_id": decision_id,
        "delta_score": outcome,
        "domain": "coding",
        "confidence_at_action": confidence,
        "timestamp": timestamp,
    }
    content = (
        f"decision_id: {decision_id} | delta_score: {outcome} | domain: coding | "
        f"confidence_at_action: {confidence} | timestamp: {timestamp}\n" + json.dumps(body)
    )
    return {
        "id": f"drawer_penny_outcomes_{decision_id}_{outcome}",
        "wing": "penny",
        "room": "outcomes",
        "filed_at": timestamp,
        "content": content,
    }


def _ledger(*drawers: dict) -> dict:
    return {"success": True, "drawers": list(drawers), "count": len(drawers)}


class TestHelpers:
    """Test parsing helpers."""

    def test_parse_dt_standard(self):
        assert _parse_dt("timestamp: 2026-04-19T15:30:00Z") == datetime(
            2026, 4, 19, 15, 30, tzinfo=timezone.utc
        )

    def test_parse_dt_offset(self):
        assert _parse_dt("timestamp: 2026-04-19T15:30:00+00:00") == datetime(
            2026, 4, 19, 15, 30, tzinfo=timezone.utc
        )

    def test_parse_dt_none(self):
        assert _parse_dt("no date here") is None

    def test_parse_confidence(self):
        assert _parse_confidence("confidence_at_action: PROBABLE") == "PROBABLE"
        assert _parse_confidence("confidence_at_action: UNCERTAIN") == "UNCERTAIN"
        assert _parse_confidence("no confidence") is None

    def test_signal_id_format(self):
        sid = _signal_id("source", 1)
        assert sid.startswith("signal_")
        assert "source" in sid

    def test_parse_outcome_text_json_body(self):
        rec = _parse_outcome_text('header line\n{"decision_id": "r9", "delta_score": "MISMATCH"}')
        assert rec["decision_id"] == "r9"
        assert rec["outcome"] == "MISMATCH"  # delta_score aliased

    def test_parse_outcome_text_header_fallback(self):
        rec = _parse_outcome_text(
            "decision_id: r7 | delta_score: MATCH | confidence_at_action: CERTAIN | "
            "timestamp: 2026-07-01T00:00:00Z"
        )
        assert rec["decision_id"] == "r7"
        assert rec["outcome"] == "MATCH"
        assert rec["confidence_at_action"] == "CERTAIN"

    @patch("signal_generators.tool_list_drawers")
    def test_load_records_naive_filed_at_normalized_utc(self, mock_list):
        mock_list.return_value = _ledger(
            {
                "id": "d",
                "wing": "penny",
                "room": "outcomes",
                "filed_at": "2026-07-01T00:00:00",  # naive, like the bridge writes
                "content": '{"decision_id": "n1", "delta_score": "MATCH"}',
            }
        )
        records = _load_outcome_records()
        assert records[0]["_when"].tzinfo is not None

    @patch("signal_generators.tool_list_drawers")
    def test_load_records_requests_full_ledger_with_content(self, mock_list):
        """Pin the request params — the accuracy fix lives in THEM.

        Every other test mocks tool_list_drawers' return value regardless of
        the request, so dropping include_content=True (content key vanishes,
        every record parses empty) or shrinking the limit back to a page
        would regress watchers to blind reads with the whole suite green.
        """
        mock_list.return_value = _ledger()
        _load_outcome_records()
        params = mock_list.call_args[0][0]
        assert params["wing"] == "penny"
        assert params["room"] == "outcomes"
        assert params["include_content"] is True
        assert params["limit"] >= 10000


class TestMismatchRateSignal:
    """Test MISMATCH rate watcher (full-ledger read)."""

    @patch("signal_generators.tool_list_drawers")
    def test_no_mismatch_under_threshold(self, mock_list):
        mock_list.return_value = _ledger(
            *[_outcome_drawer("MATCH", decision_id=f"d{i}") for i in range(5)]
        )
        result = generate_mismatch_rate_signal("test-session")
        assert result is None

    @patch("signal_generators.tool_list_drawers")
    def test_high_mismatch_rate_generates_signal(self, mock_list):
        mock_list.return_value = _ledger(
            *[_outcome_drawer("MISMATCH", decision_id=f"d{i}") for i in range(4)]
        )
        result = generate_mismatch_rate_signal("test-session", threshold=3)
        assert result is not None
        assert result["signal_type"] == "METRIC"
        assert result["source"] == "mismatch_rate_watcher"
        assert result["status"] == "PENDING"
        assert result["priority"] in ["CRITICAL", "INFO"]

    @patch("signal_generators.tool_list_drawers")
    def test_old_mismatch_not_counted(self, mock_list):
        old = _iso_days_ago(30)
        mock_list.return_value = _ledger(
            *[_outcome_drawer("MISMATCH", decision_id=f"d{i}", timestamp=old) for i in range(5)]
        )
        result = generate_mismatch_rate_signal("test-session", threshold=3, window_days=7)
        assert result is None

    @patch("signal_generators.tool_list_drawers")
    def test_critical_priority_when_double_threshold(self, mock_list):
        mock_list.return_value = _ledger(
            *[_outcome_drawer("MISMATCH", decision_id=f"d{i}") for i in range(8)]
        )
        result = generate_mismatch_rate_signal("test-session", threshold=3)
        assert result is not None
        assert result["priority"] == "CRITICAL"


class TestConfidenceTrendSignal:
    """Test confidence trend watcher (full-ledger read)."""

    @patch("signal_generators.tool_list_drawers")
    def test_no_low_confidence(self, mock_list):
        mock_list.return_value = _ledger(
            _outcome_drawer("MATCH", "d1", confidence="CERTAIN"),
            _outcome_drawer("MATCH", "d2", confidence="PROBABLE"),
        )
        result = generate_confidence_trend_signal("test-session")
        assert result is None

    @patch("signal_generators.tool_list_drawers")
    def test_low_confidence_generates_signal(self, mock_list):
        mock_list.return_value = _ledger(
            _outcome_drawer("MATCH", "d1", confidence="POSSIBLE"),
            _outcome_drawer("MATCH", "d2", confidence="UNCERTAIN"),
            _outcome_drawer("MATCH", "d3", confidence="CERTAIN"),
        )
        result = generate_confidence_trend_signal("test-session", threshold=0.5)
        assert result is not None
        assert result["signal_type"] == "METRIC"
        assert result["priority"] == "INFO"
        assert "67%" in result["title"] or "66%" in result["title"]

    @patch("signal_generators.tool_list_drawers")
    def test_blank_confidence_is_not_low(self, mock_list):
        # Unknown confidence must not count as low — it dilutes the ratio.
        mock_list.return_value = _ledger(
            _outcome_drawer("MATCH", "d1", confidence=""),
            _outcome_drawer("MATCH", "d2", confidence=""),
            _outcome_drawer("MATCH", "d3", confidence="POSSIBLE"),
        )
        result = generate_confidence_trend_signal("test-session", threshold=0.5)
        assert result is None


class TestMempalaceGrowthSignal:
    """Test mempalace growth watcher."""

    @patch("signal_generators.tool_list_drawers")
    def test_under_threshold_no_signal(self, mock_list):
        mock_list.return_value = {"success": True, "count": 100}
        result = generate_mempalace_growth_signal("test-session")
        assert result is None

    @patch("signal_generators.tool_list_drawers")
    def test_over_threshold_generates_signal(self, mock_list):
        mock_list.return_value = {"success": True, "count": 501}
        result = generate_mempalace_growth_signal("test-session", drawer_count_threshold=500)
        assert result is not None
        assert result["title"] == "Mempalace growth: 501 drawers in penny wing"
        assert result["priority"] == "INFO"


class TestTaskStalenessSignal:
    """Test task staleness watcher (full-ledger read)."""

    @patch("signal_generators.tool_list_drawers")
    def test_no_stale_tasks(self, mock_list):
        mock_list.return_value = _ledger(_outcome_drawer("MATCH", "d1"))
        result = generate_task_staleness_signal("test-session")
        assert result is None

    @patch("signal_generators.tool_list_drawers")
    def test_stale_partial_generates_signal(self, mock_list):
        mock_list.return_value = _ledger(
            _outcome_drawer("PARTIAL", "d1", timestamp=_RECENT),
            _outcome_drawer("MATCH", "d1", timestamp=_OLDER),
        )
        result = generate_task_staleness_signal("test-session", threshold_days=7)
        # The MATCH is BEFORE the PARTIAL, so d1 is still stale (no newer MATCH after PARTIAL)
        assert result is not None
        assert result["signal_type"] == "TIME"
        assert "unresolved" in result["title"]

    @patch("signal_generators.tool_list_drawers")
    def test_newer_match_resolves_staleness(self, mock_list):
        mock_list.return_value = _ledger(
            _outcome_drawer("PARTIAL", "d1", timestamp=_OLDER),
            _outcome_drawer("MATCH", "d1", timestamp=_RECENT),
        )
        result = generate_task_staleness_signal("test-session", threshold_days=7)
        assert result is None


class TestWriteSignal:
    """Test signal writing with deduplication."""

    @patch("signal_generators.tool_check_duplicate")
    @patch("signal_generators.tool_add_drawer")
    def test_duplicate_signal_skipped(self, mock_add, mock_dup):
        mock_dup.return_value = {"is_duplicate": True, "similar_content": []}
        signal = {"signal_id": "test-signal-001", "title": "Test"}
        result = write_signal(signal)
        assert result is None
        mock_add.assert_not_called()

    @patch("signal_generators.tool_check_duplicate")
    @patch("signal_generators.tool_add_drawer")
    def test_new_signal_written(self, mock_add, mock_dup):
        mock_dup.return_value = {"is_duplicate": False}
        mock_add.return_value = {"success": True, "drawer_id": "drawer_test_001"}
        signal = {"signal_id": "test-signal-002", "title": "Test"}
        result = write_signal(signal)
        assert result == "drawer_test_001"
        mock_add.assert_called_once()


if __name__ == "__main__":
    import pytest

    pytest.main([__file__, "-v"])
