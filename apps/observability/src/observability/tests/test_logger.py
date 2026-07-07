"""Unit tests for the observability structured logger."""

import json
import sys
from unittest.mock import patch

import pytest


from observability.logger import (
    LogLevel,
    debug,
    error,
    info,
    set_session_id,
    warn,
)


@pytest.fixture(autouse=True)
def clear_session():
    """Reset session ID before every test."""
    set_session_id("")
    yield
    set_session_id("")


def test_info_logs_json_to_stderr():
    # Temporarily lower level to INFO so info() is emitted
    with patch("observability.logger._LOG_LEVEL", LogLevel.INFO):
        with patch.object(sys.stderr, "write") as mock_write:
            info("observability.server", "Server started")
            assert mock_write.called
            line = mock_write.call_args[0][0]
            entry = json.loads(line.strip())
            assert entry["level"] == "INFO"
            assert entry["level_num"] == 1
            assert entry["component"] == "observability.server"
            assert entry["message"] == "Server started"
            assert "session_id" not in entry


def test_warn_includes_extra():
    with patch.object(sys.stderr, "write") as mock_write:
        warn("observability.ws", "INVALID JSON", extra={"client_id": "abc"})
        line = mock_write.call_args[0][0]
        entry = json.loads(line.strip())
        assert entry["level"] == "WARN"
        assert entry["message"] == "INVALID JSON"
        assert entry["extra"]["client_id"] == "abc"


def test_error_includes_error_object():
    try:
        raise Exception("connection refused")
    except Exception as err:
        err.code = "OBSERVERV_WS_ERROR"
        with patch.object(sys.stderr, "write") as mock_write:
            error("observability.ws", "WebSocket error", error=err)
            line = mock_write.call_args[0][0]
            entry = json.loads(line.strip())
            assert entry["level"] == "ERROR"
            assert entry["error"]["code"] == "OBSERVERV_WS_ERROR"
            assert entry["error"]["name"] == "Exception"
            assert entry["error"]["message"] == "connection refused"
            assert "stack" in entry["error"]


def test_session_id_isolated():
    set_session_id("sess-001")
    with patch.object(sys.stderr, "write") as mock_write:
        warn("observability.ws", "Connected", extra={"client": "abc"})
        line = mock_write.call_args[0][0]
        entry = json.loads(line.strip())
        assert entry["session_id"] == "sess-001"


def test_debug_below_default_level_is_suppressed():
    with patch.object(sys.stderr, "write") as mock_write:
        debug("observability.ws", "debug message")
        assert not mock_write.called


def test_session_overwrite_warns():
    set_session_id("first")
    with patch.object(sys.stderr, "write") as mock_write:
        set_session_id("second")
        calls = [c[0][0] for c in mock_write.call_args_list]
        warn_lines = [c for c in calls if "Overwriting" in c]
        assert len(warn_lines) == 1
        entry = json.loads(warn_lines[0].strip())
        assert entry["level"] == "WARN"
        assert entry["component"] == "observability.logger"

