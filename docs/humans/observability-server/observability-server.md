# Observability Server — Agent Reference

## Architecture

FastAPI + aiosqlite. Single-writer, WAL mode. Two data planes share one WebSocket connection:

- **Message plane**: session_start, message_end, tool_execution_start, tool_result, agent_start, agent_end, model_select, session_shutdown → `entries` table
- **Log plane**: `event: "log"` → `logs` table

## Code Layout

| File | Responsibility |
|------|---------------|
| `apps/observability/src/observability/main.py` | FastAPI app, WebSocket handlers, REST endpoints, lifespan |
| `apps/observability/src/observability/db.py` | SQLite DDL + CRUD (`insert_log`, `get_logs`, `cleanup_logs`, `get_log_stats`) |
| `apps/observability/src/observability/models.py` | Pydantic request/response models |
| `apps/observability/src/observability/logger.py` | Server-side structured logger (JSON/text output) |
| `apps/observability/src/observability/scheduler.py` | APScheduler daily cleanup + startup emergency cleanup |

## WebSocket Event → DB Path

```
client ──event:"log"──>  handle_message
                           └─> db.insert_log()
                                └─> INSERT INTO logs(...)
```

The `handle_message` `elif event == "log"` branch:
- Maps integer `level` enum → string (`DEBUG`/`INFO`/`WARN`/`ERROR`/`CRITICAL`)
- Extracts `extension`, `message`, `sessionId`, `error`, `context` from `data`
- Calls `_safe_insert_log` (async-tolerant; uses `asyncio.new_event_loop()` if no event loop running)

## REST API — Endpoints Relevant to Logs

### `GET /logs`

```python
list_logs(
    level: str | None,          # exact match on logs.level
    component: str | None,       # exact match on logs.component
    session_id: str | None,      # exact match on logs.session_id
    from_ts: int | None,         # logs.timestamp >= from_ts (ms)
    to_ts: int | None,           # logs.timestamp <= to_ts (ms)
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
)
→ LogListResponse(items=[LogEntry, ...], total, limit, offset)
```

### `GET /logs/stats`

```python
log_stats() → LogStatsResponse(
    total_logs: int,
    oldest_log_unix: int | None,
    newest_log_unix: int | None,
    by_level: list[dict],      # [{level, count}, ...]
    by_component: list[dict], # [{component, count}, ...]
)
```

### `GET /logs/{log_id}`

Returns a single `LogEntry` or 404. Implementation uses `get_logs(limit=1, offset=0)` and scans for `id == log_id`.

## Pydantic Models

```python
class LogEntry(BaseModel):
    id: int
    timestamp: int          # ms UNIX
    level: str
    component: str
    event: str              # the log message
    session_id: str | None
    client_id: str | None
    data: dict[str, Any] | None

class LogListResponse(BaseModel):
    items: list[LogEntry]
    total: int
    limit: int
    offset: int

class LogStatsResponse(BaseModel):
    total_logs: int
    oldest_log_unix: int | None
    newest_log_unix: int | None
    by_level: list[dict[str, int]]
    by_component: list[dict[str, int]]
```

## Database Methods

### `insert_log`

```python
async def insert_log(
    self,
    level: str,
    component: str,
    event: str,
    session_id: str | None = None,
    client_id: str | None = None,
    data: dict[str, Any] | None = None,
) → int:  # returns row id
```

- stores `timestamp` as `int(time.time() * 1000)` (ms)
- serializes `data` via `json.dumps(data)`

### `get_logs`

```python
async def get_logs(
    self,
    *,
    limit: int = 50,
    offset: int = 0,
    level: str | None = None,
    component: str | None = None,
    session_id: str | None = None,
    from_ts: int | None = None,
    to_ts: int | None = None,
) → tuple[list[dict[str, Any]], int]  # items, total
```

- `from_ts`/`to_ts` are **inclusive** millisecond bounds
- Returns `SELECT ... ORDER BY timestamp DESC LIMIT ? OFFSET ?`

### `cleanup_logs`

```python
async def cleanup_logs(self, log_retention_days: int = 14) → int:
    # DELETE FROM logs WHERE created_at < (now - retention * 86400)
```

- Returns count of rows deleted
- Called from `/admin/cleanup` endpoint alongside `db.cleanup()`

### `get_log_stats`

```python
async def get_log_stats(self) → dict[str, Any]
```

Aggregates:
- `COUNT(*)`
- `MIN(timestamp)`, `MAX(timestamp)`
- `GROUP BY level`
- `GROUP BY component`

## Schema Version Migration

On `connect()`:

1. Run full `SCHEMA_SQL` (creates all tables if missing — idempotent)
2. Check `meta.schema_version`
3. If `v1` < `SCHEMA_VERSION` (2), run migrations:
   - `CREATE TABLE logs IF NOT EXISTS`
   - `UPDATE meta SET value = '2'`

## Cursor Hygiene

All cursors from `_execute()` are closed before returning control:

- `_fetchone` / `_fetchall`: `try ... finally: cursor.close()`
- `cleanup`: explicit `cursor_raw.close()`, `cursor_comp.close()`
- `connect`: `.executescript()` cursor closed before check
- **Deleted `VACUUM` from `cleanup()`** — it caused `sqlite3.OperationalError: cannot VACUUM - SQL statements in progress` when prepared statements were still alive.

## Extension → Server Flow

```
.skribblez/logger.ts  createLogger("memory")
  └─> writes to globalTransport (if set)
      └─> observability/index.ts  setGlobalLogTransport(handler)
          └─> ws.send({ event: "log", data: logEntry })
              └─> Python main.py handle_message()
                  └─> db.insert_log()
```

## Extension Changes

No changes needed in individual extensions. The `observability` extension alone:

1. Imports `createLogger, setSessionId, setGlobalLogTransport` from `../../lib/logger/logger.js`
2. In `ws.on("open", ...)`:
   - Calls `setGlobalLogTransport(transportFn)`
   - `transportFn` wraps the JSON logger output into a `{"event":"log", ...}` envelope and sends via WebSocket
3. In `ws.on("close", ...)` and `ws.on("error", ...)`:
   - Calls `setGlobalLogTransport(undefined)` to tear down and prevent write-after-close

## Connection Safeguards

- Drops silently if `!state.connected` or `ws.readyState !== WebSocket.OPEN`
- Ignores transport failures with `catch {}` to avoid recursive logging
- `_safe_insert_log` on the Python side catches all DB errors and logs to `stderr` only (never raises)

## Error Codes

See `docs/agents/capabilities/error-logging/error-codes.md` for the full taxonomy. Server-side additions:

| Code | Component | Context |
|------|-----------|---------|
| `OBSERVERV_WS_ERROR` | server | WebSocket endpoint exception |
| `OBSERVERV_WS_CLOSE_ERROR` | server | WebSocket close() failure |
| `OBSERVERV_WS_INVALID_JSON` | server | Invalid JSON from client |
| `OBSERVERV_SCHEDULER_FAIL` | scheduler | Cleanup job failed |
| `OBSERVERV_STARTUP_CLEANUP_FAIL` | scheduler | Emergency cleanup failed |

## Penny Tools (Extension-Registered)

The observability extension registers two tools for Penny to query server data directly:

| Tool | REST Endpoint | Parameters |
|------|---------------|------------|
| `observability_query_logs` | `GET /logs` | `level`, `component`, `session_id`, `from_ts`, `to_ts`, `limit`, `offset` |
| `observability_query_history` | `GET /sessions/{id}/entries` or `GET /sessions` | `session_id`, `limit`, `offset` |

- Both tools call the REST API using `fetch` with Bearer auth (when `PI_OBSERVABILITY_API_KEY` is set)
- The `observabilityFetch` helper handles URL construction, headers, and JSON parsing
- Tool `execute` functions catch all errors and return `{ isError: true, content: [...] }` on failure
- These tools are **stateless** — no session state, no orchestration, direct data retrieval

Use pattern: Penny calls the tool → gets JSON → analyzes/correlates → decides next step.

## Testing

| Test Suite | File | Count | Coverage |
|-----------|------|-------|----------|
| Unit (logs) | `tests/test_logs.py` | 16 | Table CRUD, filtering, stats, cleanup, migration |
| Unit (db) | `tests/test_db.py` | 8 | Schema, sessions, entries, compactions |
| Integration (logs) | `tests/test_logs_integration.py` | 9 | FastAPI endpoints via TestClient |
| Integration (auth) | `tests/test_auth.py` | 9 | Bearer token auth, open endpoints |
| Integration (scheduler) | `tests/test_scheduler.py` | 5 | APScheduler cleanup jobs |
| Integration (pipeline) | `tests/test_integration.py` | 5 | Full WebSocket → REST pipeline |
| E2E | `tests/test_e2e.py` | 7 | Live server: health, WS log ingestion, REST queries, admin stats |
| TypeScript (unit) | `.pi/extensions/observability/tests/unit/` | 30 | WebSocket mock, reconnection, logging |
| TypeScript (integration) | `.pi/extensions/observability/tests/integration/` | 11 | Tool registration, message format |

**Total: 59 Python + 41 TypeScript = 100 tests**

Run all tests:

```bash
cd apps/observability && PYTHONPATH=src python -m pytest tests/ -q
cd .pi/extensions/observability && bun run test:all
```

# 2026-05-07 | Observability Server Real-time Log Streaming (complete) | Added SQLite logs table with insert_log/get_logs/cleanup_logs/get_log_stats, REST endpoints (GET /logs /logs/stats /logs/{log_id}), WebSocket handler for event="log", TypeScript shared logger setGlobalLogTransport wired to observability extension WebSocket, 52 Python + 30 TypeScript tests passing. Removed VACUUM from cleanup() to eliminate flaky sqlite3 race condition. Cursor hygiene enforced throughout. | ★★★★★
