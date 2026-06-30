# Observability Server

## What It Is

The Penny Observability Server is a Python FastAPI + SQLite backend that ingests real-time events and structured log entries from all Penny extensions. It replaces the old Node.js console-log server with persistent storage and a queryable REST API.

## Two Data Planes

| Plane | Transport | Content | Retention |
|-------|-----------|---------|-----------|
| **Events** | WebSocket | Session lifecycle, messages, tool results, agent boundaries, compactions | 14 days (raw entries) |
| **Operational Logs** | WebSocket (`event: "log"`) | Structured JSON logs from `.pi/lib/logger/logger.ts` | 14 days (logs table) |

Both planes share the same WebSocket connection — the extension sends `event: "message_end"` for the message plane and `event: "log"` for the structured logging plane.

## Real-time Log Streaming

Every extension that imports `createLogger` from `.pi/lib/logger/logger.ts` automatically streams structured log entries to the observability server **whenever the WebSocket is connected**.

### How It Works

1. WebSocket connects (`ws://localhost:8765/ws` by default)
2. The observability extension calls `setGlobalLogTransport()` with a handler that sends `event: "log"` messages via the WebSocket
3. Every `createLogger` instance writes to this global transport — no code changes needed in other extensions
4. The server receives the `log` event, parses the structured entry, and writes it to the SQLite `logs` table via `insert_log()`

### Log Entry Format (WebSocket → Server)

```json
{
  "event": "log",
  "sessionId": "sess-abc-123",
  "timestamp": 1746624000000,
  "data": {
    "level": 2,
    "extension": "memory",
    "message": "Bridge timeout after 30s",
    "sessionId": "sess-abc-123",
    "context": { "tool": "mempalace_search" },
    "error": {
      "name": "Error",
      "message": "Bridge timeout after 30s",
      "code": "BRIDGE_TIMEOUT"
    }
  }
}
```

- `level`: integer enum `0=DEBUG, 1=INFO, 2=WARN, 3=ERROR, 4=CRITICAL`
- `extension`: the extension name passed to `createLogger("memory")`
- `data.sessionId`: redundant with top-level `sessionId` — the server normalizes both

## Penny Tools

Two tools are registered by the observability extension for Penny to query data directly:

| Tool | Purpose | Parameters |
|------|---------|------------|
| `observability_query_logs` | Query operational logs | `level`, `component`, `session_id`, `from_ts`, `to_ts`, `limit`, `offset` |
| `observability_query_history` | Query conversation history | `session_id`, `limit`, `offset` |

Penny calls these tools directly to diagnose issues, correlate errors with conversation events, or investigate system behavior. No skill orchestration needed — Penny decides what to query and how to analyze the results.

## REST API — Log Endpoints

> Auth: Bearer token when `PI_OBSERVABILITY_API_KEY` is set; otherwise open.

| Method | Path | Query Params | Response |
|--------|------|-------------|----------|
| `GET` | `/logs` | `?level=ERROR&component=memory&session_id=sess-abc&from_ts=0&to_ts=999999&limit=50&offset=0` | `{items:[], total, limit, offset}` |
| `GET` | `/logs/stats` | — | `{total_logs, oldest_log_unix, newest_log_unix, by_level:[], by_component:[]}` |
| `GET` | `/logs/{log_id}` | — | Single `LogEntry` object |

### Example

```bash
curl -H "Authorization: Bearer $PI_OBSERVABILITY_API_KEY" \
  "http://localhost:8765/logs?level=ERROR&limit=10"
```

## Log Table Schema (SQLite)

```sql
CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,          -- millisecond UNIX ts
    level TEXT NOT NULL,                 -- DEBUG, INFO, WARN, ERROR, CRITICAL
    component TEXT NOT NULL,             -- extension name
    event TEXT NOT NULL,                 -- log message
    session_id TEXT,
    client_id TEXT,
    data JSON                            -- context + error object
);
CREATE INDEX idx_logs_timestamp ON logs(timestamp);
CREATE INDEX idx_logs_level ON logs(level);
CREATE INDEX idx_logs_component ON logs(component);
CREATE INDEX idx_logs_session ON logs(session_id);
```

## Schema Migration

The server auto-detects old databases (v1, missing `logs` table) and runs:

```sql
CREATE TABLE logs (...);
UPDATE meta SET value = '2' WHERE key = 'schema_version';
```

Existing sessions, entries, and compactions are preserved.

## Cleanup & Retention

Scheduled cleanup (via APScheduler at 03:00 UTC) deletes logs older than `RETENTION_LOG_DAYS` (default 14).

## Auto-Start Behavior

The observability extension automatically starts the Python server when Pi loads, if:

1. `PI_OBSERVABILITY_ENABLED` is not set to `false`
2. `PI_OBSERVABILITY_AUTO_START` is not set to `false` (default: `true`)
3. The server is not already running (detected via `GET /health`)

The extension spawns: `python -m observability` with `PYTHONPATH=apps/observability/src`

To disable auto-start: `PI_OBSERVABILITY_AUTO_START=false`

## Extension Configuration

Set in `.env`:

```bash
PI_OBSERVABILITY_URL=ws://localhost:8765/ws
PI_OBSERVABILITY_API_KEY=your-secret-key
PI_OBSERVABILITY_AUTO_START=true   # auto-start server on Pi launch (default true)
PI_LOG_LEVEL=WARN                   # filter extension-side before sending
PI_LOG_FORMAT=json                  # or "text" for human-readable
```

## Learn More

- Implementation: `apps/observability/src/observability/` (FastAPI app, db.py, models.py, scheduler.py)
- Extension: `.pi/extensions/observability/index.ts`
- Shared logger: `.pi/lib/logger/logger.ts`
- Error codes: `docs/agents/capabilities/error-logging/error-codes.md`
