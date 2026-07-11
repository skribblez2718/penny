"""FastAPI WebSocket + REST server for Penny observability.

Ingests events from the Pi observability extension via WebSocket,
persists them to SQLite, and exposes REST endpoints for querying.
"""

import json
import signal
import sys
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from observability.config import Config
from observability.db import Database
from observability import scheduler as _scheduler
from observability import logger as _logger
from observability.models import (
    CreateLogRequest,
    CreateOrchestrationEventsRequest,
    CreateOrchestrationRunRequest,
    LogEntry,
    LogListResponse,
    LogStatsResponse,
    WatcherLogEntry,
    WatcherLogListResponse,
    WatcherLogStatsResponse,
)

# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------

# FastAPI HTTPBearer for REST endpoint dependency
_security = HTTPBearer(auto_error=False)


def _extract_api_key(
    query_params: Any,
    headers: Any,
) -> str | None:
    """Read API key from headers (WebSocket or HTTP) — Bearer token only."""
    # Bearer token in Authorization header
    if hasattr(headers, "get"):
        auth = headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            return auth[7:]
    return None


def _api_key_valid(provided: str | None) -> bool:
    """Return True if auth is disabled or key matches."""
    expected = Config.API_KEY
    if not expected:
        return True  # Auth disabled
    if not provided:
        return False
    return provided == expected


async def require_auth(
    credentials: HTTPAuthorizationCredentials | None = Depends(_security),
) -> str | None:
    """FastAPI dependency: validate Bearer token on REST endpoints.

    Returns the token string if valid, or None if auth is disabled.
    Raises HTTPException(401) if auth is enabled but token is missing/invalid.
    """
    expected = Config.API_KEY
    if not expected:
        return None  # Auth disabled

    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if credentials.credentials != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return credentials.credentials


# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------

db: Database | None = None
active_connections: set[WebSocket] = set()
connection_stats: dict[str, dict[str, Any]] = {}  # clientId -> stats


def _safe_insert_log(
    level: str,
    component: str,
    event: str,
    session_id: str | None = None,
    client_id: str | None = None,
    data: dict[str, Any] | None = None,
) -> None:
    """Insert an operational log to the DB, swallowing any errors.

    Logging must never crash the server — failures fall back to stderr.
    """
    if db is None:
        return
    try:
        import asyncio
        try:
            # Fast path: async context with a running loop
            loop = asyncio.get_running_loop()
            loop.create_task(
                db.insert_log(level, component, event, session_id, client_id, data)
            )
        except RuntimeError:
            # No running loop — create one temporarily for sync contexts
            _logger.debug(
                "observability.server",
                "No running event loop; using a temporary loop for sync operational-log write",
            )
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(
                    db.insert_log(level, component, event, session_id, client_id, data)
                )
            finally:
                loop.close()
    except Exception as exc:
        err = RuntimeError(str(exc))
        err.code = "OBSERV_DBLOG_WRITE_FAILED"
        _logger.warn(
            "observability.server",
            "Failed to write operational log to DB",
            error=err,
            extra={"component": component, "event": event},
        )


# ---------------------------------------------------------------------------
# Message handlers (shared between WS and future HTTP POST)
# ---------------------------------------------------------------------------

async def handle_message(
    message: dict[str, Any],
    client_id: str,
) -> None:
    """Dispatch a single observability message to the database."""
    if db is None:
        return

    event = message.get("event", "unknown")
    session_id = message.get("sessionId", "unknown")
    timestamp = message.get("timestamp", int(time.time() * 1000))
    data = message.get("data", {})

    # Determine role for entries that carry one
    role = _extract_role(event, data)

    if event == "session_start":
        model = data.get("model") or {}
        await db.upsert_session(
            session_id=session_id,
            cwd=data.get("cwd"),
            model_provider=model.get("provider"),
            model_id=model.get("model"),
            started_at=timestamp,
        )

    elif event == "session_shutdown":
        await db.close_session(
            session_id=session_id,
            ended_at=timestamp,
        )

    elif event in {
        "message_end",
        "tool_execution_start",
        "tool_result",
        "agent_start",
        "agent_end",
        "model_select",
    }:
        # Ensure the session placeholder exists before inserting entries
        # (handles reconnects without a preceding session_start)
        existing = await db.get_session(session_id)
        if existing is None:
            await db.upsert_session(session_id=session_id, started_at=timestamp)

        await db.insert_entry(
            session_id=session_id,
            event_type=event,
            timestamp=timestamp,
            data=data,
            role=role,
        )

    elif event == "log":
        # Real-time structured log entry from extension logger
        log_data = data if isinstance(data, dict) else {}
        level = log_data.get("level", "INFO")
        # Map integer LogLevel enum back to string
        if isinstance(level, int):
            level_map = {0: "DEBUG", 1: "INFO", 2: "WARN", 3: "ERROR", 4: "CRITICAL"}
            level = level_map.get(level, "INFO")
        else:
            level = str(level).upper()
        component = log_data.get("extension", "unknown")
        message = log_data.get("message", "")
        session_id_val = log_data.get("sessionId") or session_id
        error_obj = log_data.get("error")
        context_obj = log_data.get("context")
        merged_data: dict[str, Any] = {}
        if context_obj:
            merged_data["context"] = context_obj
        if error_obj:
            merged_data["error"] = error_obj
        _safe_insert_log(
            level=level,
            component=component,
            event=message,
            session_id=session_id_val,
            data=merged_data or None,
        )

    # Structured console logging (mirror old Node.js server style)
    ts_iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(timestamp / 1000))
    role = data.get("role", "—")
    extra = {"event": event, "session_id": session_id, "role": role}
    if event == "message_end":
        content_preview = _preview_content(data.get("content"), 80)
        _logger.info("observability.server", f"[{ts_iso}] [{session_id}] {role:15} {content_preview}", extra)
    elif event == "tool_execution_start":
        _logger.info("observability.server", f"[{ts_iso}] [{session_id}] tool: {data.get('toolName')}", extra)
    elif event == "tool_result":
        status = "error" if data.get("isError") else "ok"
        _logger.info("observability.server", f"[{ts_iso}] [{session_id}] tool_result: {data.get('toolName')} ({status})", extra | {"status": status})
    elif event == "session_start":
        _logger.info("observability.server", f"[{ts_iso}] [{session_id}] SESSION START cwd={data.get('cwd')}", extra)
    elif event == "session_shutdown":
        _logger.info("observability.server", f"[{ts_iso}] [{session_id}] SESSION END duration={data.get('duration')}ms", extra)
    elif event == "agent_start":
        _logger.info("observability.server", f"[{ts_iso}] [{session_id}] AGENT START", extra)
    elif event == "agent_end":
        _logger.info("observability.server", f"[{ts_iso}] [{session_id}] AGENT END messages={data.get('messageCount')}", extra | {"message_count": data.get("messageCount")})
    elif event == "model_select":
        model = data.get("model")
        prev = data.get("previousModel")
        mid = model["id"] if model else "null"
        pid = prev["id"] if prev else "null"
        _logger.info("observability.server", f"[{ts_iso}] [{session_id}] MODEL {pid} → {mid} ({data.get('source')})", extra | {"prev_model": pid, "model": mid, "source": data.get("source")})
    else:
        _logger.info("observability.server", f"[{ts_iso}] [{session_id}] {event}", extra)


def _extract_role(event: str, data: dict[str, Any]) -> str | None:
    """Pull role out of the payload for message_end events."""
    if event == "message_end":
        return data.get("role")
    if event == "tool_execution_start":
        return "tool_execution"
    if event == "tool_result":
        return "toolResult"
    if event == "agent_start":
        return "agent"
    if event == "agent_end":
        return "agent"
    if event == "model_select":
        return "system"
    return None


def _log_message(
    event: str,
    session_id: str,
    timestamp: int,
    data: dict[str, Any],
) -> None:
    """Console logging matching the old Node.js server's style."""
    ts_iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(timestamp / 1000))
    role = data.get("role", "—")
    extra = {"event": event, "session_id": session_id, "role": role}
    if event == "message_end":
        content_preview = _preview_content(data.get("content"), 80)
        _logger.info("observability.server", f"Console log: [{ts_iso}] [{session_id}] {role:15} {content_preview}", extra)
    elif event == "tool_execution_start":
        _logger.info("observability.server", f"Console log: [{ts_iso}] [{session_id}] tool: {data.get('toolName')}", extra)
    elif event == "tool_result":
        status = "error" if data.get("isError") else "ok"
        _logger.info("observability.server", f"Console log: [{ts_iso}] [{session_id}] tool_result: {data.get('toolName')} ({status})", extra | {"status": status})
    elif event == "session_start":
        _logger.info("observability.server", f"Console log: [{ts_iso}] [{session_id}] SESSION START cwd={data.get('cwd')}", extra)
    elif event == "session_shutdown":
        _logger.info("observability.server", f"Console log: [{ts_iso}] [{session_id}] SESSION END duration={data.get('duration')}ms", extra)
    elif event == "agent_start":
        _logger.info("observability.server", f"Console log: [{ts_iso}] [{session_id}] AGENT START", extra)
    elif event == "agent_end":
        _logger.info("observability.server", f"Console log: [{ts_iso}] [{session_id}] AGENT END messages={data.get('messageCount')}", extra | {"message_count": data.get("messageCount")})
    elif event == "model_select":
        model = data.get("model")
        prev = data.get("previousModel")
        mid = model["id"] if model else "null"
        pid = prev["id"] if prev else "null"
        _logger.info("observability.server", f"Console log: [{ts_iso}] [{session_id}] MODEL {pid} → {mid} ({data.get('source')})", extra | {"prev_model": pid, "model": mid, "source": data.get("source")})
    else:
        _logger.info("observability.server", f"Console log: [{ts_iso}] [{session_id}] {event}", extra)


def _preview_content(content: Any, max_len: int) -> str:
    """Build a short text preview from a content payload."""
    if content is None:
        return ""
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        # Array of content blocks; grab the first text block
        texts = [
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        text = texts[0] if texts else json.dumps(content)[:80]
    elif isinstance(content, dict):
        text = content.get("text", content.get("output", json.dumps(content)[:80]))
    else:
        text = str(content)

    if len(text) > max_len:
        return text[:max_len] + "..."
    return text


# ---------------------------------------------------------------------------
# FastAPI lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    global db

    _logger.info("observability.server", "═" * 60)
    _logger.info("observability.server", "  Penny Observability Server")
    _logger.info("observability.server", "═" * 60)

    db = Database()
    await db.connect()
    stats = await db.get_stats()
    _logger.info("observability.server", f"  DB:        {stats['db_path']}")
    _logger.info("observability.server", f"  Size:      {stats['db_size_mb']:.2f} MB")
    _logger.info("observability.server", f"  Sessions:  {stats['session_count']}")
    _logger.info("observability.server", f"  Entries:   {stats['entry_count']}")
    _logger.info("observability.server", f"  WebSocket: ws://{Config.HOST}:{Config.PORT}{Config.WS_PATH}")
    _logger.info("observability.server", f"  REST:      http://{Config.HOST}:{Config.PORT}/health")
    _logger.info("observability.server", f"  Auth:      {'enabled' if Config.API_KEY else 'disabled'}")
    _logger.info("observability.server", "═" * 60)
    _logger.info("observability.server", "Waiting for connections...")

    _scheduler.start_scheduler(db)

    yield

    # Shutdown
    _logger.info("observability.server", "Shutting down...")
    _scheduler.stop_scheduler()
    for ws in list(active_connections):
        try:
            await ws.close(code=1001, reason="Server shutting down")
        except Exception as exc:
            err = Exception(str(exc))
            err.code = "OBSERVERV_WS_CLOSE_ERROR"
            _logger.warn(
                "observability.server",
                "Error closing WebSocket on shutdown",
                error=err,
            )
    active_connections.clear()

    if db:
        await db.close()

    _logger.info("observability.server", "Server closed")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Penny Observability",
    version=__import__("observability").__version__,
    lifespan=lifespan,
)




@app.get("/health")
async def health() -> dict[str, Any]:
    """Report server health and DB statistics (no auth required)."""
    if db is None:
        return {"status": "error", "detail": "Database not connected"}

    stats = await db.get_stats()
    return {
        "status": "healthy",
        "connections": len(active_connections),
        "uptime": int(time.time() - _start_time) if "_start_time" in globals() else 0,
        **stats,
    }


# ---------------------------------------------------------------------------
# Session endpoints
# ---------------------------------------------------------------------------

@app.get("/sessions")
async def list_sessions(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _token: str | None = Depends(require_auth),
) -> dict[str, Any]:
    """List all sessions with pagination."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    items, total = await db.list_sessions(limit=limit, offset=offset)
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@app.get("/sessions/{session_id}")
async def get_session(
    session_id: str,
    _token: str | None = Depends(require_auth),
) -> dict[str, Any]:
    """Get metadata for a single session."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    sess = await db.get_session(session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return sess


# ---------------------------------------------------------------------------
# Entry endpoints
# ---------------------------------------------------------------------------

@app.get("/sessions/{session_id}/entries")
async def get_entries(
    session_id: str,
    from_idx: int | None = Query(None, ge=0),
    to_idx: int | None = Query(None, ge=0),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    event_type: str | None = Query(None),
    _token: str | None = Depends(require_auth),
) -> dict[str, Any]:
    """Return paginated entries for a session."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    items, total = await db.get_entries(
        session_id=session_id,
        from_idx=from_idx,
        to_idx=to_idx,
        limit=limit,
        offset=offset,
        event_type=event_type,
    )
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@app.get("/sessions/{session_id}/search")
async def search_entries(
    session_id: str,
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=100),
    _token: str | None = Depends(require_auth),
) -> dict[str, Any]:
    """Full-text search over entries for a session via FTS5."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    items = await db.search_entries(session_id=session_id, query=q, limit=limit)
    return {"items": items, "query": q, "limit": limit}


# ---------------------------------------------------------------------------
# Compaction endpoints
# ---------------------------------------------------------------------------

@app.post("/compactions")
async def post_compaction(
    request_body: dict[str, Any],
    _token: str | None = Depends(require_auth),
) -> dict[str, Any]:
    """Store a compaction artifact."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")

    session_id = request_body.get("session_id", "")
    compaction_seq = request_body.get("compaction_seq", 0)

    existing = await db.get_session(session_id)
    if existing is None:
        await db.upsert_session(session_id=session_id, started_at=int(time.time() * 1000))

    await db.insert_compaction(
        session_id=session_id,
        compaction_seq=compaction_seq,
        compaction_timestamp=request_body.get("compaction_timestamp", ""),
        artifact=request_body.get("artifact", {}),
        first_kept_entry_id=request_body.get("first_kept_entry_id"),
        tokens_before=request_body.get("tokens_before"),
    )
    return {"status": "ok", "session_id": session_id, "compaction_seq": compaction_seq}


@app.get("/sessions/{session_id}/compactions")
async def list_compactions(
    session_id: str,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _token: str | None = Depends(require_auth),
) -> dict[str, Any]:
    """List compaction artifacts for a session."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    items, total = await db.get_compactions(session_id=session_id, limit=limit, offset=offset)
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@app.get("/sessions/{session_id}/compactions/{compaction_seq}")
async def get_compaction(
    session_id: str,
    compaction_seq: int,
    _token: str | None = Depends(require_auth),
) -> dict[str, Any]:
    """Get a specific compaction artifact."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    item = await db.get_compaction(session_id, compaction_seq)
    if item is None:
        raise HTTPException(status_code=404, detail="Compaction not found")
    return item


# ---------------------------------------------------------------------------
# Admin endpoints
# ---------------------------------------------------------------------------

@app.post("/admin/cleanup")
async def trigger_cleanup(
    _token: str | None = Depends(require_auth),
) -> dict[str, Any]:
    """Manually trigger a size-based rotation (same routine the scheduler runs)."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    cap_bytes = int(Config.DB_SIZE_MAX_GB * (1024**3))
    floor_bytes = int(Config.DB_SIZE_FLOOR_GB * (1024**3))
    result = await db.rotate(cap_bytes, floor_bytes)
    return {"status": "ok", **result}


@app.get("/admin/stats")
async def admin_stats(
    _token: str | None = Depends(require_auth),
) -> dict[str, Any]:
    """Detailed server statistics."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    stats = await db.get_stats()
    return {
        **stats,
        "active_connections": len(active_connections),
        "db_size_max_gb": Config.DB_SIZE_MAX_GB,
        "db_size_floor_gb": Config.DB_SIZE_FLOOR_GB,
    }


# ---------------------------------------------------------------------------
# Log endpoints
# ---------------------------------------------------------------------------

@app.post("/logs")
async def create_log(
    request_body: CreateLogRequest,
    _token: str | None = Depends(require_auth),
) -> dict[str, Any]:
    """Ingest a structured operational log entry from an external source."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    log_id = await db.insert_log(
        level=request_body.level,
        component=request_body.component,
        event=request_body.event,
        session_id=request_body.session_id,
        client_id=request_body.client_id,
        data=request_body.data,
    )
    return {"status": "ok", "id": log_id}


@app.get("/logs")
async def list_logs(
    level: str | None = Query(None),
    component: str | None = Query(None),
    session_id: str | None = Query(None),
    from_ts: int | None = Query(None, ge=0),
    to_ts: int | None = Query(None, ge=0),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _token: str | None = Depends(require_auth),
) -> LogListResponse:
    """List operational logs with optional filters and pagination."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    items, total = await db.get_logs(
        limit=limit,
        offset=offset,
        level=level,
        component=component,
        session_id=session_id,
        from_ts=from_ts,
        to_ts=to_ts,
    )
    return LogListResponse(items=items, total=total, limit=limit, offset=offset)


@app.get("/logs/stats")
async def log_stats(
    _token: str | None = Depends(require_auth),
) -> LogStatsResponse:
    """Return aggregated statistics over the logs table."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    stats = await db.get_log_stats()
    return LogStatsResponse(**stats)


@app.get("/logs/{log_id}")
async def get_log(
    log_id: int,
    _token: str | None = Depends(require_auth),
) -> LogEntry:
    """Get a single operational log entry by ID."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    items, _ = await db.get_logs(limit=1, offset=0)
    for item in items:
        if item["id"] == log_id:
            return LogEntry(**item)
    raise HTTPException(status_code=404, detail="Log not found")


# ---------------------------------------------------------------------------
# Watcher log endpoints
# ---------------------------------------------------------------------------

@app.post("/watcher_logs")
async def create_watcher_log(
    request_body: dict[str, Any],
    _token: str | None = Depends(require_auth),
) -> dict[str, Any]:
    """Ingest a structured ambient watcher log entry."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    source = request_body.get("source")
    event = request_body.get("event")
    if not source or not event:
        raise HTTPException(status_code=422, detail="source and event are required")
    log_id = await db.insert_watcher_log(
        level=request_body.get("level", "INFO"),
        source=source,
        event=event,
        session_id=request_body.get("session_id"),
        data=request_body.get("data"),
    )
    return {"status": "ok", "id": log_id}


@app.get("/watcher_logs")
async def list_watcher_logs(
    level: str | None = Query(None),
    source: str | None = Query(None),
    session_id: str | None = Query(None),
    from_ts: int | None = Query(None, ge=0),
    to_ts: int | None = Query(None, ge=0),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _token: str | None = Depends(require_auth),
) -> WatcherLogListResponse:
    """List ambient watcher logs with optional filters and pagination."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    items, total = await db.get_watcher_logs(
        limit=limit,
        offset=offset,
        level=level,
        source=source,
        session_id=session_id,
        from_ts=from_ts,
        to_ts=to_ts,
    )
    return WatcherLogListResponse(items=items, total=total, limit=limit, offset=offset)


@app.get("/watcher_logs/stats")
async def watcher_log_stats(
    _token: str | None = Depends(require_auth),
) -> WatcherLogStatsResponse:
    """Return aggregated statistics over the watcher_logs table."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    stats = await db.get_watcher_log_stats()
    return WatcherLogStatsResponse(**stats)


@app.get("/watcher_logs/{log_id}")
async def get_watcher_log(
    log_id: int,
    _token: str | None = Depends(require_auth),
) -> WatcherLogEntry:
    """Get a single ambient watcher log entry by ID."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    items, _ = await db.get_watcher_logs(limit=1, offset=0)
    for item in items:
        if item["id"] == log_id:
            return WatcherLogEntry(**item)
    raise HTTPException(status_code=404, detail="Watcher log not found")


# Set start time when module loads
_start_time = int(time.time())


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------

@app.websocket(Config.WS_PATH)
async def websocket_endpoint(websocket: WebSocket) -> None:
    """Primary ingestion endpoint — receives events from the Pi extension."""
    client_id = f"{int(time.time() * 1000)}-{id(websocket):x}"
    client_ip = websocket.client.host if websocket.client else "unknown"

    # Auth check before accepting
    api_key = _extract_api_key(
        websocket.query_params,
        websocket.headers,
    )
    if not _api_key_valid(api_key):
        _logger.warn(
            "observability.server",
            f"REJECTED client={client_id} ip={client_ip}",
            extra={"client_id": client_id, "client_ip": client_ip},
        )
        _safe_insert_log("WARN", "auth", "auth_failure", client_id=client_id, data={"reason": "invalid_api_key", "ip": client_ip})
        await websocket.close(code=1008, reason="Authentication failed")
        return

    await websocket.accept()
    active_connections.add(websocket)
    connection_stats[client_id] = {
        "connectedAt": int(time.time() * 1000),
        "ip": client_ip,
        "messageCount": 0,
    }

    _logger.info(
        "observability.server",
        f"CONNECTED client={client_id} ip={client_ip} total={len(active_connections)}",
        extra={"client_id": client_id, "client_ip": client_ip, "total_connections": len(active_connections)},
    )
    _safe_insert_log("INFO", "server", "client_connected", client_id=client_id, data={"ip": client_ip, "total_connections": len(active_connections)})

    # Send welcome
    await websocket.send_json(
        {
            "type": "welcome",
            "clientId": client_id,
            "serverTime": int(time.time() * 1000),
        }
    )

    try:
        while True:
            raw = await websocket.receive_text()
            stats = connection_stats.get(client_id)
            if stats:
                stats["messageCount"] += 1

            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                _logger.warn(
                    "observability.server",
                    "INVALID JSON",
                    extra={"client_id": client_id, "raw": raw[:200]},
                )
                _safe_insert_log("WARN", "server", "invalid_json", client_id=client_id, data={"raw_preview": raw[:200]})
                continue

            await handle_message(message, client_id)

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        err = Exception(str(exc))
        err.code = "OBSERVERV_WS_ERROR"
        _logger.error(
            "observability.server",
            f"WebSocket error for client={client_id}",
            error=err,
            extra={"client_id": client_id},
        )
        _safe_insert_log("ERROR", "server", "websocket_error", client_id=client_id, data={"error": str(exc)})
    finally:
        active_connections.discard(websocket)
        stats = connection_stats.pop(client_id, {})
        duration = int(time.time() * 1000) - stats.get("connectedAt", 0)
        msg_count = stats.get("messageCount", 0)
        _logger.info(
            "observability.server",
            f"DISCONNECTED client={client_id} duration={duration}ms messages={msg_count} total={len(active_connections)}",
            extra={"client_id": client_id, "duration_ms": duration, "messages": msg_count, "total_connections": len(active_connections)},
        )
        _safe_insert_log("INFO", "server", "client_disconnected", client_id=client_id, data={"duration_ms": duration, "messages": msg_count})


# ---------------------------------------------------------------------------
# Graceful shutdown signal handler
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Orchestration endpoints (v5) — the correlated timeline. Ingest is best-effort
# from the engine's obs_client; queries power the correlation view.
# ---------------------------------------------------------------------------


@app.post("/orchestration/runs")
async def post_orchestration_run(
    request_body: CreateOrchestrationRunRequest,
    _token: str | None = Depends(require_auth),
) -> dict[str, Any]:
    """Create or update an orchestration run (run_start / run_end)."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    await db.upsert_orchestration_run(
        run_id=request_body.run_id,
        session_id=request_body.session_id,
        playbook=request_body.playbook,
        goal=request_body.goal,
        status=request_body.status,
        started_at=request_body.started_at,
        ended_at=request_body.ended_at,
        met=request_body.met,
        iterations=request_body.iterations,
    )
    return {"status": "ok", "run_id": request_body.run_id}


@app.post("/orchestration/events")
async def post_orchestration_events(
    request_body: CreateOrchestrationEventsRequest,
    _token: str | None = Depends(require_auth),
) -> dict[str, Any]:
    """Ingest one or a small batch of orchestration event digests."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    ids: list[int] = []
    for ev in request_body.events:
        row_id = await db.insert_orchestration_event(
            run_id=ev.run_id,
            session_id=ev.session_id,
            seq=ev.seq,
            event_type=ev.event_type,
            state_id=ev.state_id,
            primitive=ev.primitive,
            agent=ev.agent,
            data=ev.data,
            timestamp=ev.timestamp,
        )
        ids.append(row_id)
    return {"status": "ok", "count": len(ids), "ids": ids}


@app.get("/orchestration/runs")
async def list_orchestration_runs(
    session_id: str | None = Query(None),
    status: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    _token: str | None = Depends(require_auth),
) -> dict[str, Any]:
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    runs = await db.get_orchestration_runs(session_id=session_id, status=status, limit=limit)
    return {"items": runs, "total": len(runs)}


@app.get("/orchestration/runs/{run_id}")
async def get_orchestration_run(
    run_id: str,
    _token: str | None = Depends(require_auth),
) -> dict[str, Any]:
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    run = await db.get_orchestration_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


@app.get("/orchestration/runs/{run_id}/events")
async def get_orchestration_run_events(
    run_id: str,
    _token: str | None = Depends(require_auth),
) -> dict[str, Any]:
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    events = await db.get_orchestration_events(run_id)
    return {"items": events, "total": len(events)}


@app.get("/sessions/{session_id}/orchestration")
async def get_session_orchestration(
    session_id: str,
    _token: str | None = Depends(require_auth),
) -> dict[str, Any]:
    """The correlation view: all orchestration runs (with events) for a session,
    correlated with Pi agent/tool events by the shared session_id."""
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    return await db.get_session_orchestration(session_id)


# ---------------------------------------------------------------------------
# Signal handling
# ---------------------------------------------------------------------------


def _handle_signal(signum: int, _frame: Any) -> None:
    """Exit cleanly on SIGINT/SIGTERM."""
    _logger.info("observability.server", f"Received signal {signum}, exiting...")
    sys.exit(0)


signal.signal(signal.SIGINT, _handle_signal)
signal.signal(signal.SIGTERM, _handle_signal)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    """Run the server with uvicorn."""
    import uvicorn

    uvicorn.run(
        "observability.main:app",
        host=Config.HOST,
        port=Config.PORT,
        log_level="warning",
        reload=False,
    )


if __name__ == "__main__":
    main()
