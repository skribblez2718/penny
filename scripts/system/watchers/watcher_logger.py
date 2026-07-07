"""
Watcher Logger — Structured logging client for ambient watchers.

Sends structured log entries to the Penny observability server via HTTP POST
to /watcher_logs. Falls back to stderr if the server is unreachable.

Environment:
    PENNY_OBSERVABILITY_URL — REST base URL (default: http://localhost:8765)
    PENNY_OBSERVABILITY_API_KEY — API key for auth (default: "")
    PI_OBSERVABILITY_REST_URL — Alternative REST base URL (used by compaction ext)
    PI_OBSERVABILITY_API_KEY — Alternative API key (used by observability ext)
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any, Optional

import requests

DEFAULT_URL = "http://localhost:8765"


def _get_base_url() -> str:
    """Resolve the observability REST base URL from environment."""
    url = (
        os.getenv("PENNY_OBSERVABILITY_URL")
        or os.getenv("PI_OBSERVABILITY_REST_URL")
        or DEFAULT_URL
    )
    # Strip trailing slashes and /ws suffix
    url = url.rstrip("/")
    if url.endswith("/ws"):
        url = url[:-3]
    return url


def _get_api_key() -> str:
    return os.getenv("PENNY_OBSERVABILITY_API_KEY") or os.getenv("PI_OBSERVABILITY_API_KEY") or ""


def _send_log(
    level: str,
    source: str,
    event: str,
    session_id: Optional[str] = None,
    data: Optional[dict[str, Any]] = None,
) -> bool:
    """POST a single log entry to /watcher_logs. Returns True on success."""
    base_url = _get_base_url()
    api_key = _get_api_key()
    payload = {
        "level": level,
        "source": source,
        "event": event,
        "timestamp": int(time.time() * 1000),
    }
    if session_id is not None:
        payload["session_id"] = session_id
    if data is not None:
        payload["data"] = data

    headers: dict[str, str] = {"Content-Type": "application/json", "Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    try:
        resp = requests.post(
            f"{base_url}/watcher_logs",
            json=payload,
            headers=headers,
            timeout=5,
        )
        return resp.status_code in (200, 201)
    except requests.RequestException:
        return False


def _fallback(
    level: str,
    source: str,
    event: str,
    session_id: Optional[str] = None,
    data: Optional[dict[str, Any]] = None,
) -> None:
    """Write structured JSON line to stderr when the server is unreachable."""
    entry: dict[str, Any] = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "level": level,
        "source": source,
        "event": event,
    }
    if session_id is not None:
        entry["session_id"] = session_id
    if data is not None:
        entry["data"] = data
    sys.stderr.write(json.dumps(entry) + "\n")


def log(
    level: str,
    source: str,
    event: str,
    session_id: Optional[str] = None,
    data: Optional[dict[str, Any]] = None,
) -> None:
    """Send a structured watcher log entry. Falls back to stderr on failure."""
    ok = _send_log(level, source, event, session_id, data)
    if not ok:
        _fallback(level, source, event, session_id, data)


def debug(
    source: str, event: str, session_id: Optional[str] = None, data: Optional[dict[str, Any]] = None
) -> None:
    log("DEBUG", source, event, session_id, data)


def info(
    source: str, event: str, session_id: Optional[str] = None, data: Optional[dict[str, Any]] = None
) -> None:
    log("INFO", source, event, session_id, data)


def warn(
    source: str, event: str, session_id: Optional[str] = None, data: Optional[dict[str, Any]] = None
) -> None:
    log("WARN", source, event, session_id, data)


def error(
    source: str, event: str, session_id: Optional[str] = None, data: Optional[dict[str, Any]] = None
) -> None:
    log("ERROR", source, event, session_id, data)


def exception(
    source: str, event: str, exc: BaseException, session_id: Optional[str] = None
) -> None:
    """Log an exception with traceback details."""
    import traceback as _traceback

    log(
        "ERROR",
        source,
        event,
        session_id,
        data={
            "error": str(exc),
            "error_type": type(exc).__name__,
            "traceback": _traceback.format_exc(),
        },
    )
