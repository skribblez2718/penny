"""
Tests for signal generation functions.
"""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

# Ensure venv
_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_BRIDGE_DIR = _PROJECT_ROOT / "scripts" / "system" / "bridge"
if str(_BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(_BRIDGE_DIR))

sys.path.insert(0, str(Path(__file__).parent))

from signal_generators import (  # noqa: E402
    generate_mismatch_rate_signal,
    generate_confidence_trend_signal,
    generate_mempalace_growth_signal,
    generate_task_staleness_signal,
    write_signal,
    _parse_dt,
    _has_delta,
    _parse_confidence,
    _signal_id,
)


# Dynamic timestamps so tests never go stale due to time-window filtering
_RECENT = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
_RECENT_TS = f"timestamp: {_RECENT}"
_OLDER = (datetime.now(timezone.utc) - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")


class TestHelpers:
    """Test parsing helpers."""

    def test_parse_dt_standard(self):
        assert _parse_dt("timestamp: 2026-04-19T15:30:00Z") == datetime(2026, 4, 19, 15, 30, tzinfo=timezone.utc)

    def test_parse_dt_offset(self):
        assert _parse_dt("timestamp: 2026-04-19T15:30:00+00:00") == datetime(2026, 4, 19, 15, 30, tzinfo=timezone.utc)

    def test_parse_dt_none(self):
        assert _parse_dt("no date here") is None

    def test_has_delta_yes(self):
        assert _has_delta("delta_score: MISMATCH", "MISMATCH")
        assert _has_delta("delta_score: MATCH", "MATCH")

    def test_has_delta_no(self):
        assert not _has_delta("delta_score: MATCH", "MISMATCH")

    def test_parse_confidence(self):
        assert _parse_confidence("confidence_at_action: PROBABLE") == "PROBABLE"
        assert _parse_confidence("confidence_at_action: UNCERTAIN") == "UNCERTAIN"
        assert _parse_confidence("no confidence") is None

    def test_signal_id_format(self):
        sid = _signal_id("source", 1)
        assert sid.startswith("signal_")
        assert "source" in sid


class TestMismatchRateSignal:
    """Test MISMATCH rate watcher."""

    @patch('signal_generators.tool_smart_search')
    def test_no_mismatch_under_threshold(self, mock_search):
        mock_search.return_value = {
            "success": True,
            "results": [{"summary": f"delta_score: MATCH\n{_RECENT_TS}"}] * 5
        }
        result = generate_mismatch_rate_signal("test-session")
        assert result is None

    @patch('signal_generators.tool_smart_search')
    def test_high_mismatch_rate_generates_signal(self, mock_search):
        mock_search.return_value = {
            "success": True,
            "results": [
                {"summary": f"delta_score: MISMATCH\n{_RECENT_TS}"},
                {"summary": f"delta_score: MISMATCH\n{_RECENT_TS}"},
                {"summary": f"delta_score: MISMATCH\n{_RECENT_TS}"},
                {"summary": f"delta_score: MISMATCH\n{_RECENT_TS}"},
            ]
        }
        result = generate_mismatch_rate_signal("test-session", threshold=3)
        assert result is not None
        assert result["signal_type"] == "METRIC"
        assert result["source"] == "mismatch_rate_watcher"
        assert result["status"] == "PENDING"
        assert result["priority"] in ["CRITICAL", "INFO"]

    @patch('signal_generators.tool_smart_search')
    def test_old_mismatch_not_counted(self, mock_search):
        old = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
        mock_search.return_value = {
            "success": True,
            "results": [
                {"summary": f"delta_score: MISMATCH\ntimestamp: {old}"}
            ] * 5
        }
        result = generate_mismatch_rate_signal("test-session", threshold=3, window_days=7)
        assert result is None

    @patch('signal_generators.tool_smart_search')
    def test_critical_priority_when_double_threshold(self, mock_search):
        results = [{"summary": f"delta_score: MISMATCH\n{_RECENT_TS}"}] * 8
        mock_search.return_value = {"success": True, "results": results}
        result = generate_mismatch_rate_signal("test-session", threshold=3)
        assert result is not None
        assert result["priority"] == "CRITICAL"


class TestConfidenceTrendSignal:
    """Test confidence trend watcher."""

    @patch('signal_generators.tool_smart_search')
    def test_no_low_confidence(self, mock_search):
        mock_search.return_value = {
            "success": True,
            "results": [
                {"summary": f"confidence_at_action: CERTAIN\n{_RECENT_TS}"},
                {"summary": f"confidence_at_action: PROBABLE\n{_RECENT_TS}"},
            ]
        }
        result = generate_confidence_trend_signal("test-session")
        assert result is None

    @patch('signal_generators.tool_smart_search')
    def test_low_confidence_generates_signal(self, mock_search):
        mock_search.return_value = {
            "success": True,
            "results": [
                {"summary": f"confidence_at_action: POSSIBLE\n{_RECENT_TS}"},
                {"summary": f"confidence_at_action: UNCERTAIN\n{_RECENT_TS}"},
                {"summary": f"confidence_at_action: CERTAIN\n{_RECENT_TS}"},
            ]
        }
        result = generate_confidence_trend_signal("test-session", threshold=0.5)
        assert result is not None
        assert result["signal_type"] == "METRIC"
        assert result["priority"] == "INFO"
        assert "67%" in result["title"] or "66%" in result["title"]


class TestMempalaceGrowthSignal:
    """Test mempalace growth watcher."""

    @patch('signal_generators.tool_list_drawers')
    def test_under_threshold_no_signal(self, mock_list):
        mock_list.return_value = {"success": True, "count": 100}
        result = generate_mempalace_growth_signal("test-session")
        assert result is None

    @patch('signal_generators.tool_list_drawers')
    def test_over_threshold_generates_signal(self, mock_list):
        mock_list.return_value = {"success": True, "count": 501}
        result = generate_mempalace_growth_signal("test-session", drawer_count_threshold=500)
        assert result is not None
        assert result["title"] == "Mempalace growth: 501 drawers in penny wing"
        assert result["priority"] == "INFO"


class TestTaskStalenessSignal:
    """Test task staleness watcher."""

    @patch('signal_generators.tool_smart_search')
    def test_no_stale_tasks(self, mock_search):
        mock_search.return_value = {
            "success": True,
            "results": [
                {"summary": f"decision_id: d1\ndelta_score: MATCH\ntimestamp: {_RECENT}"}
            ]
        }
        result = generate_task_staleness_signal("test-session")
        assert result is None

    @patch('signal_generators.tool_smart_search')
    def test_stale_partial_generates_signal(self, mock_search):
        mock_search.return_value = {
            "success": True,
            "results": [
                {"summary": f"decision_id: d1\ndelta_score: PARTIAL\ntimestamp: {_RECENT}"},
                {"summary": f"decision_id: d1\ndelta_score: MATCH\ntimestamp: {_OLDER}"},
            ]
        }
        result = generate_task_staleness_signal("test-session", threshold_days=7)
        # The MATCH is BEFORE the PARTIAL, so d1 is still stale (no newer MATCH after PARTIAL)
        assert result is not None
        assert result["signal_type"] == "TIME"
        assert "unresolved" in result["title"]


class TestWriteSignal:
    """Test signal writing with deduplication."""

    @patch('signal_generators.tool_check_duplicate')
    @patch('signal_generators.tool_add_drawer')
    def test_duplicate_signal_skipped(self, mock_add, mock_dup):
        mock_dup.return_value = {"is_duplicate": True, "similar_content": []}
        signal = {"signal_id": "test-signal-001", "title": "Test"}
        result = write_signal(signal)
        assert result is None
        mock_add.assert_not_called()

    @patch('signal_generators.tool_check_duplicate')
    @patch('signal_generators.tool_add_drawer')
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
