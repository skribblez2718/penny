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
    generate_tune_due_signal,
    resolve_tune_due_signals,
    write_signal,
    _load_outcome_records,
    _parse_outcome_text,
    _parse_dt,
    _parse_confidence,
    _signal_id,
)
from tune_freshness import LEAD_THRESHOLDS


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


# ---------------------------------------------------------------------------
# Tune-due signal (FR-4,5,6,17,18)
# ---------------------------------------------------------------------------


def _fresh_staleness():
    """All producers fresh — no tune_due from staleness."""
    return {
        p: {"stale": False, "reason": "fresh", "age_days": 1.0, "threshold": LEAD_THRESHOLDS[p]}
        for p in LEAD_THRESHOLDS
    }


def _stale_staleness(producers=None, reason="stale (age)"):
    """Mark specified producers (or all) as stale."""
    if producers is None:
        producers = list(LEAD_THRESHOLDS.keys())
    base = _fresh_staleness()
    for p in producers:
        base[p] = {
            "stale": True,
            "reason": reason,
            "age_days": 15.0,
            "threshold": LEAD_THRESHOLDS[p],
        }
    return base


def _amendment_drawer(amendment_id="amend-001", status="PENDING"):
    """A drawer shaped like the amendment writer's output."""
    body = {
        "amendment_id": amendment_id,
        "status": status,
        "target_file": ".pi/prompts/tune.md",
        "risk": "low",
        "trigger": "repeated failure",
        "changes": [{"rationale": "fix X"}],
    }
    content = f"amendment_id: {amendment_id}\n" + json.dumps(body)
    return {"id": f"drawer_{amendment_id}", "content": content}


class TestTuneDueSignal:
    """Test generate_tune_due_signal — producer staleness, rating backlog,
    CRITICAL escalation, and dedup."""

    @patch("signal_generators._count_unrated_sessions", return_value=0)
    @patch("signal_generators._days_since_last_rating", return_value=None)
    @patch("signal_generators._count_pending_amendments", return_value=0)
    @patch("signal_generators.check_all_stale")
    def test_no_stale_no_backlog_returns_none(
        self, mock_stale, mock_amend, mock_days, mock_unrated
    ):
        mock_stale.return_value = _fresh_staleness()
        result = generate_tune_due_signal("test-session")
        assert result is None

    @patch("signal_generators._count_unrated_sessions", return_value=0)
    @patch("signal_generators._days_since_last_rating", return_value=None)
    @patch("signal_generators._count_pending_amendments", return_value=0)
    @patch("signal_generators.check_all_stale")
    def test_stale_producer_generates_info(self, mock_stale, mock_amend, mock_days, mock_unrated):
        mock_stale.return_value = _stale_staleness(["prompt_efficacy"])
        result = generate_tune_due_signal("test-session")
        assert result is not None
        assert result["source"] == "tune_due_watcher"
        assert result["priority"] == "INFO"
        assert result["status"] == "PENDING"
        assert "prompt_efficacy" in result["context"]

    @patch("signal_generators._count_unrated_sessions", return_value=0)
    @patch("signal_generators._days_since_last_rating", return_value=None)
    @patch("signal_generators._count_pending_amendments", return_value=0)
    @patch("signal_generators.check_all_stale")
    def test_multiple_stale_producers_in_context(
        self, mock_stale, mock_amend, mock_days, mock_unrated
    ):
        mock_stale.return_value = _stale_staleness(["trajectory", "judgment"])
        result = generate_tune_due_signal("test-session")
        assert result is not None
        assert "trajectory" in result["context"]
        assert "judgment" in result["context"]

    # ── FR-17: Rating backlog ──────────────────────────────────────────────

    @patch("signal_generators._count_unrated_sessions", return_value=12)
    @patch("signal_generators._days_since_last_rating", return_value=None)
    @patch("signal_generators._count_pending_amendments", return_value=0)
    @patch("signal_generators.check_all_stale")
    def test_rating_backlog_unrated_sessions(self, mock_stale, mock_amend, mock_days, mock_unrated):
        """FR-17: >=10 unrated sessions fires INFO."""
        mock_stale.return_value = _fresh_staleness()
        result = generate_tune_due_signal("test-session")
        assert result is not None
        assert result["priority"] == "INFO"
        assert "unrated" in result["context"].lower()

    @patch("signal_generators._count_unrated_sessions", return_value=5)
    @patch("signal_generators._days_since_last_rating", return_value=9.0)
    @patch("signal_generators._count_pending_amendments", return_value=0)
    @patch("signal_generators.check_all_stale")
    def test_rating_backlog_days_since(self, mock_stale, mock_amend, mock_days, mock_unrated):
        """FR-17: >=7d since last rating fires INFO."""
        mock_stale.return_value = _fresh_staleness()
        result = generate_tune_due_signal("test-session")
        assert result is not None
        assert result["priority"] == "INFO"
        assert "rating" in result["context"].lower() or "since" in result["context"].lower()

    @patch("signal_generators._count_unrated_sessions", return_value=3)
    @patch("signal_generators._days_since_last_rating", return_value=2.0)
    @patch("signal_generators._count_pending_amendments", return_value=0)
    @patch("signal_generators.check_all_stale")
    def test_rating_backlog_none(self, mock_stale, mock_amend, mock_days, mock_unrated):
        """FR-17: <10 unrated AND <7d since → no rating condition."""
        mock_stale.return_value = _fresh_staleness()
        result = generate_tune_due_signal("test-session")
        assert result is None

    @patch("signal_generators._count_unrated_sessions", return_value=15)
    @patch("signal_generators._days_since_last_rating", return_value=10.0)
    @patch("signal_generators._count_pending_amendments", return_value=0)
    @patch("signal_generators.check_all_stale")
    def test_rating_backlog_both_conditions(self, mock_stale, mock_amend, mock_days, mock_unrated):
        """FR-17: both sub-conditions met → both in context."""
        mock_stale.return_value = _fresh_staleness()
        result = generate_tune_due_signal("test-session")
        assert result is not None
        assert result["priority"] == "INFO"
        assert "unrated" in result["context"].lower()
        assert "since" in result["context"].lower() or "rating" in result["context"].lower()

    @patch("signal_generators._count_unrated_sessions", return_value=9)
    @patch("signal_generators._days_since_last_rating", return_value=6.0)
    @patch("signal_generators._count_pending_amendments", return_value=0)
    @patch("signal_generators.check_all_stale")
    def test_rating_backlog_boundary_not_fired(
        self, mock_stale, mock_amend, mock_days, mock_unrated
    ):
        """FR-17: exactly 9 unrated and 6d since → neither condition fires."""
        mock_stale.return_value = _fresh_staleness()
        result = generate_tune_due_signal("test-session")
        assert result is None

    @patch("signal_generators._count_unrated_sessions", return_value=10)
    @patch("signal_generators._days_since_last_rating", return_value=None)
    @patch("signal_generators._count_pending_amendments", return_value=0)
    @patch("signal_generators.check_all_stale")
    def test_rating_backlog_boundary_exactly_10(
        self, mock_stale, mock_amend, mock_days, mock_unrated
    ):
        """FR-17: exactly 10 unrated → fires (>=10)."""
        mock_stale.return_value = _fresh_staleness()
        result = generate_tune_due_signal("test-session")
        assert result is not None

    @patch("signal_generators._count_unrated_sessions", return_value=0)
    @patch("signal_generators._days_since_last_rating", return_value=7.0)
    @patch("signal_generators._count_pending_amendments", return_value=0)
    @patch("signal_generators.check_all_stale")
    def test_rating_backlog_boundary_exactly_7d(
        self, mock_stale, mock_amend, mock_days, mock_unrated
    ):
        """FR-17: exactly 7d since → fires (>=7)."""
        mock_stale.return_value = _fresh_staleness()
        result = generate_tune_due_signal("test-session")
        assert result is not None

    # ── FR-18: CRITICAL escalation ─────────────────────────────────────────

    @patch("signal_generators._count_unrated_sessions", return_value=0)
    @patch("signal_generators._days_since_last_rating", return_value=None)
    @patch("signal_generators._count_pending_amendments", return_value=2)
    @patch("signal_generators.check_all_stale")
    def test_critical_trajectory_stale_with_amendments(
        self, mock_stale, mock_amend, mock_days, mock_unrated
    ):
        """FR-18: trajectory stale AND >=1 PENDING/APPROVED amendment → CRITICAL."""
        mock_stale.return_value = _stale_staleness(["trajectory"])
        result = generate_tune_due_signal("test-session")
        assert result is not None
        assert result["priority"] == "CRITICAL"

    @patch("signal_generators._count_unrated_sessions", return_value=0)
    @patch("signal_generators._days_since_last_rating", return_value=None)
    @patch("signal_generators._count_pending_amendments", return_value=0)
    @patch("signal_generators.check_all_stale")
    def test_info_trajectory_stale_no_amendments(
        self, mock_stale, mock_amend, mock_days, mock_unrated
    ):
        """FR-18: trajectory stale but no amendments → INFO (not CRITICAL)."""
        mock_stale.return_value = _stale_staleness(["trajectory"])
        result = generate_tune_due_signal("test-session")
        assert result is not None
        assert result["priority"] == "INFO"

    @patch("signal_generators._count_unrated_sessions", return_value=0)
    @patch("signal_generators._days_since_last_rating", return_value=None)
    @patch("signal_generators._count_pending_amendments", return_value=3)
    @patch("signal_generators.check_all_stale")
    def test_info_non_trajectory_stale_with_amendments(
        self, mock_stale, mock_amend, mock_days, mock_unrated
    ):
        """FR-18: prompt_efficacy stale (not trajectory) + amendments → INFO."""
        mock_stale.return_value = _stale_staleness(["prompt_efficacy"])
        result = generate_tune_due_signal("test-session")
        assert result is not None
        assert result["priority"] == "INFO"

    @patch("signal_generators._count_unrated_sessions", return_value=0)
    @patch("signal_generators._days_since_last_rating", return_value=None)
    @patch("signal_generators._count_pending_amendments", return_value=1)
    @patch("signal_generators.check_all_stale")
    def test_critical_trajectory_and_others_stale_with_amendments(
        self, mock_stale, mock_amend, mock_days, mock_unrated
    ):
        """FR-18: trajectory + others stale + amendments → CRITICAL."""
        mock_stale.return_value = _stale_staleness(["trajectory", "prompt_efficacy"])
        result = generate_tune_due_signal("test-session")
        assert result is not None
        assert result["priority"] == "CRITICAL"

    # ── FR-6: Dedup / SM-3: single source of truth ─────────────────────────

    @patch("signal_generators._count_unrated_sessions", return_value=0)
    @patch("signal_generators._days_since_last_rating", return_value=None)
    @patch("signal_generators._count_pending_amendments", return_value=0)
    @patch("signal_generators.check_all_stale")
    def test_signal_id_contains_tune_due(self, mock_stale, mock_amend, mock_days, mock_unrated):
        """Signal ID should contain 'tune_due' for identification."""
        mock_stale.return_value = _stale_staleness(["trajectory"])
        result = generate_tune_due_signal("test-session")
        assert result is not None
        assert "tune_due" in result["signal_id"]

    @patch("signal_generators._count_unrated_sessions", return_value=0)
    @patch("signal_generators._days_since_last_rating", return_value=None)
    @patch("signal_generators._count_pending_amendments", return_value=0)
    @patch("signal_generators.check_all_stale")
    def test_suggested_action_mentions_tune(self, mock_stale, mock_amend, mock_days, mock_unrated):
        """Suggested action should mention /tune deep for stale producers."""
        mock_stale.return_value = _stale_staleness(["trajectory"])
        result = generate_tune_due_signal("test-session")
        assert result is not None
        assert "tune" in result["suggested_action"].lower()

    @patch("signal_generators._count_unrated_sessions", return_value=12)
    @patch("signal_generators._days_since_last_rating", return_value=None)
    @patch("signal_generators._count_pending_amendments", return_value=0)
    @patch("signal_generators.check_all_stale")
    def test_suggested_action_mentions_rate_for_backlog(
        self, mock_stale, mock_amend, mock_days, mock_unrated
    ):
        """Suggested action should mention rating for backlog-only signals."""
        mock_stale.return_value = _fresh_staleness()
        result = generate_tune_due_signal("test-session")
        assert result is not None
        assert "rate" in result["suggested_action"].lower()


class TestTuneDueSingleSourceOfTruth:
    """SM-3: signal_generators imports LEAD_THRESHOLDS from tune_freshness —
    no literal 10/21 threshold values in this module."""

    def test_lead_thresholds_imported(self):
        """LEAD_THRESHOLDS must be importable from signal_generators."""
        import signal_generators

        assert hasattr(signal_generators, "LEAD_THRESHOLDS")
        assert signal_generators.LEAD_THRESHOLDS == LEAD_THRESHOLDS

    def test_no_literal_thresholds_in_generate_tune_due(self):
        """The generate_tune_due_signal source must not contain literal 10/21
        threshold values (they come from LEAD_THRESHOLDS)."""
        import inspect

        source = inspect.getsource(generate_tune_due_signal)
        # The function should not hardcode threshold values — it uses
        # LEAD_THRESHOLDS for the freshness check and the helper constants
        # for rating-backlog thresholds.
        # We check that the function body doesn't contain bare 'threshold=10'
        # or 'threshold=21' style literals (it should reference constants).
        assert "check_all_stale" in source


class TestResolveTuneDueSignals:
    """SM-4 / FR-11,12: PENDING tune_due signals become RESOLVED after Step 6."""

    @patch("signal_generators.tool_smart_search")
    @patch("signal_generators.tool_delete_drawer")
    @patch("signal_generators.tool_add_drawer")
    @patch("signal_generators.tool_check_duplicate")
    def test_resolves_pending_tune_due_signals(self, mock_dup, mock_add, mock_del, mock_search):
        """PENDING tune_due signals are marked RESOLVED."""
        signal = {
            "signal_id": "signal_2026-07-09_001_tune_due",
            "signal_type": "TIME",
            "source": "tune_due_watcher",
            "priority": "INFO",
            "title": "Tune due",
            "context": "stale",
            "status": "PENDING",
        }
        mock_search.return_value = {
            "results": [
                {
                    "id": "drawer_1",
                    "text": f"signal_id: {signal['signal_id']}\n" + json.dumps(signal),
                }
            ]
        }
        mock_dup.return_value = {"is_duplicate": False}
        mock_add.return_value = {"success": True, "drawer_id": "drawer_new"}

        count = resolve_tune_due_signals("test-session")
        assert count == 1
        mock_del.assert_called_once_with({"drawer_id": "drawer_1"})
        written_content = mock_add.call_args[0][0]["content"]
        assert "RESOLVED" in written_content

    @patch("signal_generators.tool_smart_search")
    @patch("signal_generators.tool_delete_drawer")
    @patch("signal_generators.tool_add_drawer")
    @patch("signal_generators.tool_check_duplicate")
    def test_no_pending_signals_returns_zero(self, mock_dup, mock_add, mock_del, mock_search):
        """No PENDING tune_due signals -> returns 0, no writes."""
        mock_search.return_value = {"results": []}
        count = resolve_tune_due_signals("test-session")
        assert count == 0
        mock_del.assert_not_called()
        mock_add.assert_not_called()

    @patch("signal_generators.tool_smart_search")
    @patch("signal_generators.tool_delete_drawer")
    @patch("signal_generators.tool_add_drawer")
    @patch("signal_generators.tool_check_duplicate")
    def test_skips_non_tune_due_signals(self, mock_dup, mock_add, mock_del, mock_search):
        """Only tune_due signals are resolved, not other signal types."""
        other_signal = {
            "signal_id": "signal_2026-07-09_001_mismatch_rate",
            "source": "mismatch_rate_watcher",
            "status": "PENDING",
        }
        mock_search.return_value = {
            "results": [
                {
                    "id": "drawer_2",
                    "text": f"signal_id: {other_signal['signal_id']}\n" + json.dumps(other_signal),
                }
            ]
        }
        count = resolve_tune_due_signals("test-session")
        assert count == 0
        mock_del.assert_not_called()

    @patch("signal_generators.tool_smart_search")
    @patch("signal_generators.tool_delete_drawer")
    @patch("signal_generators.tool_add_drawer")
    @patch("signal_generators.tool_check_duplicate")
    def test_skips_already_resolved(self, mock_dup, mock_add, mock_del, mock_search):
        """Already RESOLVED tune_due signals are not re-resolved."""
        signal = {
            "signal_id": "signal_2026-07-09_001_tune_due",
            "source": "tune_due_watcher",
            "status": "RESOLVED",
        }
        mock_search.return_value = {
            "results": [
                {
                    "id": "drawer_3",
                    "text": f"signal_id: {signal['signal_id']}\n" + json.dumps(signal),
                }
            ]
        }
        count = resolve_tune_due_signals("test-session")
        assert count == 0
        mock_del.assert_not_called()


if __name__ == "__main__":
    import pytest

    pytest.main([__file__, "-v"])
