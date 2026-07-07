"""Structured logging for the Penny Observability Server.

Mirrors the TypeScript shared logger design:
- Severity levels: DEBUG, INFO, WARN, ERROR, CRITICAL
- Output: JSON lines to stderr (default) or human-readable text
- Every emitted log carries: timestamp, level, component, message, session_id, error.code
- Logs include error objects at ERROR+ with code, name, message, stack
- Log level controlled via PI_LOG_LEVEL env var (default WARN)
- Log format controlled via PI_LOG_FORMAT env var (default json)

Schema (JSON mode):
{
  "timestamp": "2026-05-07T16:30:05.123Z",
  "level": "ERROR",
  "level_num": 3,
  "component": "observability.server",
  "message": "Connection refused",
  "session_id": "sess-abc-123",
  "error": {
    "code": "OBSERVERV_WS_ERROR",
    "name": "Error",
    "message": "Connection refused",
    "stack": "..."
  },
  "extra": { "client_id": "...", "uri": "ws://..." }
}
"""

import json
import os
import sys
import time
import traceback
from enum import IntEnum
from typing import Any, Optional


class LogLevel(IntEnum):
    DEBUG = 0
    INFO = 1
    WARN = 2
    ERROR = 3
    CRITICAL = 4


# Environment overrides  
_LOG_LEVEL = LogLevel.DEBUG if os.getenv("PI_LOG_LEVEL", "").upper() == "DEBUG" else \
             LogLevel.INFO if os.getenv("PI_LOG_LEVEL", "").upper() == "INFO" else \
             LogLevel.WARN if os.getenv("PI_LOG_LEVEL", "").upper() == "WARN" else \
             LogLevel.ERROR if os.getenv("PI_LOG_LEVEL", "").upper() == "ERROR" else \
             LogLevel.CRITICAL if os.getenv("PI_LOG_LEVEL", "").upper() == "CRITICAL" else \
             LogLevel.WARN

_LOG_FORMAT = os.getenv("PI_LOG_FORMAT", "json").lower()


# Global session ID (analogous to TypeScript globalSessionId)
_session_id: str = ""


def set_session_id(sid: str) -> None:
    """Set the global session ID for log correlation."""
    global _session_id
    if _session_id and sid and _session_id != sid:
        _emit_no_lock(
            level=LogLevel.WARN,
            level_name="WARN",
            component="observability.logger",
            message=f"Overwriting session_id from '{_session_id}' to '{sid}'",
            error=None,
            extra=None,
        )
    _session_id = sid


def get_session_id() -> str:
    return _session_id


def _level_name(level: LogLevel) -> str:
    return {
        LogLevel.DEBUG: "DEBUG",
        LogLevel.INFO: "INFO",
        LogLevel.WARN: "WARN",
        LogLevel.ERROR: "ERROR",
        LogLevel.CRITICAL: "CRITICAL",
    }[level]


def _serialize_error(err: Optional[BaseException]) -> Optional[dict[str, Any]]:
    if err is None:
        return None
    code = getattr(err, "code", None)
    stack = "".join(traceback.format_exception(type(err), err, err.__traceback__)) if err.__traceback__ else None
    return {
        "name": type(err).__name__,
        "message": str(err),
        **({"code": code} if code else {}),
        **({"stack": stack} if stack else {}),
    }


def _emit_no_lock(
    level: LogLevel,
    level_name: str,
    component: str,
    message: str,
    error: Optional[BaseException] = None,
    extra: Optional[dict[str, Any]] = None,
) -> None:
    """Emit a log entry without checking the level (internal)."""
    ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
    if _LOG_FORMAT == "json":
        entry: dict[str, Any] = {
            "timestamp": ts,
            "level": level_name,
            "level_num": int(level),
            "component": component,
            "message": message,
        }
        if _session_id:
            entry["session_id"] = _session_id
        serialized = _serialize_error(error)
        if serialized:
            entry["error"] = serialized
        if extra:
            entry["extra"] = extra
        sys.stderr.write(json.dumps(entry) + "\n")
    else:
        # human-readable text format
        parts = [f"[{ts}] [{level_name}] [{component}]"]
        if _session_id:
            parts.append(f"[session_id={_session_id}]")
        parts.append(message)
        if error:
            parts.append(f"error={error}")
        if extra:
            parts.append(f"extra={extra}")
        # DEBUG and lower go to stdout, WARN+ to stderr
        target = sys.stdout if level <= LogLevel.INFO else sys.stderr
        target.write(" ".join(parts) + "\n")
    # stdout is line-buffered, stderr is unbuffered; no explicit flush needed on stderr


def _emit(level: LogLevel, component: str, message: str, extra: Optional[dict[str, Any]] = None, error: Optional[BaseException] = None) -> None:
    if level < _LOG_LEVEL:
        return
    _emit_no_lock(level, _level_name(level), component, message, error, extra)


# Convenience methods
def debug(component: str, message: str, extra: Optional[dict[str, Any]] = None) -> None:
    _emit(LogLevel.DEBUG, component, message, extra)


def info(component: str, message: str, extra: Optional[dict[str, Any]] = None) -> None:
    _emit(LogLevel.INFO, component, message, extra)


def warn(component: str, message: str, extra: Optional[dict[str, Any]] = None, error: Optional[BaseException] = None) -> None:
    _emit(LogLevel.WARN, component, message, extra, error)


def error(component: str, message: str, extra: Optional[dict[str, Any]] = None, error: Optional[BaseException] = None) -> None:
    _emit(LogLevel.ERROR, component, message, extra, error)


def critical(component: str, message: str, extra: Optional[dict[str, Any]] = None, error: Optional[BaseException] = None) -> None:
    _emit(LogLevel.CRITICAL, component, message, extra, error)
