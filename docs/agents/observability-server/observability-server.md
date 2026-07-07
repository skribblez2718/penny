# Observability Server — Agent Reference

## What

The Penny Observability Server is a FastAPI + SQLite backend that ingests two data planes over a single WebSocket and exposes them through a queryable REST API.

| Plane | WebSocket event | Stored in | Use case |
|-------|-----------------|-----------|----------|
| **Message plane** | `session_start`, `message_end`, `tool_execution_start`, `tool_result`, `agent_start`, `agent_end`, `model_select`, `session_shutdown` | `entries` + `sessions` tables | Reconstruct a conversation timeline |
| **Log plane** | `event: "log"` | `logs` table | Query structured operational logs by level, component, session |
| **Watcher log plane** | `event: "watcher_log"` (or POST `/watcher_logs`) | `watcher_logs` table | Diagnose ambient watcher behavior and signal generation |

Penny does not query the database directly. The observability extension registers three tools that hit the REST API and return JSON.

## Why

Persistent, structured telemetry lets an agent diagnose failures after the fact, correlate errors with conversation events, and verify watcher behavior without asking the user to paste logs.

## Rules

1. **Always prefer the registered tools.** Use `observability_query_logs`, `observability_query_history`, and `observability_query_watcher_logs` instead of raw `curl` or DB access.
2. **Query narrow, then widen.** Filter by `session_id` and/or `level` first; remove filters only if you need broader context.
3. **Combine planes for diagnosis.** A failure in `logs` is usually easier to interpret when correlated with the `history` timeline for the same `session_id`.
4. **Respect retention.** Operational logs and entries are retained for **14 days** by default; watcher logs for **14 days**. Older data is removed by the scheduled cleanup job.
5. **Timestamps are milliseconds.** Both `from_ts` and `to_ts` are inclusive millisecond UNIX timestamps.
6. **No auth token = open API.** When `PI_OBSERVABILITY_API_KEY` is set, all tools send a `Bearer` token; otherwise the endpoints are open.
7. **Do not write observability data to the project tree.** Query results are ephemeral analysis inputs, not deliverables.

## Procedure

### 1. Server connection

Default WebSocket URL: `ws://localhost:8765/ws`  
Default HTTP URL: `http://localhost:8765`  
The extension auto-starts the server unless `PI_OBSERVABILITY_ENABLED=false` or `PI_OBSERVABILITY_AUTO_START=false`.

### 2. Query operational logs

Tool: `observability_query_logs`

REST endpoint: `GET /logs`

| Query param | Type | Match |
|-------------|------|-------|
| `level` | string | exact: `DEBUG`, `INFO`, `WARN`, `ERROR`, `CRITICAL` |
| `component` | string | exact extension name (`memory`, `skill`, `observability`, ...) |
| `session_id` | string | exact session UUID |
| `from_ts` | int | `timestamp >= from_ts` (ms) |
| `to_ts` | int | `timestamp <= to_ts` (ms) |
| `limit` | int | 1–500, default 50 |
| `offset` | int | default 0 |

Log level enum (from `.pi/lib/logger/logger.ts`):

```
DEBUG    = 0
INFO     = 1
WARN     = 2
ERROR    = 3
CRITICAL = 4
```

Example tool call:

```typescript
observability_query_logs({
  level: "ERROR",
  component: "memory",
  session_id: "sess-abc-123",
  limit: 10,
})
```

Example curl:

```bash
curl -H "Authorization: Bearer $PI_OBSERVABILITY_API_KEY" \
  "http://localhost:8765/logs?level=ERROR&component=memory&limit=10"
```

Stats endpoint: `GET /logs/stats`

```bash
curl -H "Authorization: Bearer $PI_OBSERVABILITY_API_KEY" \
  http://localhost:8765/logs/stats
```

Single log: `GET /logs/{log_id}`

### 3. Query conversation history

Tool: `observability_query_history`

REST endpoints:
- `GET /sessions` — list sessions (omit `session_id`)
- `GET /sessions/{session_id}` — single session metadata
- `GET /sessions/{session_id}/entries` — chronological events for that session
- `GET /sessions/{session_id}/search` — search entries by text

> **Note:** The task description references `/history` and `/history/sessions`. Those endpoints do not exist in the current server implementation; history queries are served through `/sessions` and `/sessions/{id}/entries`.

Example tool call:

```typescript
// List recent sessions
observability_query_history({ limit: 20 })

// Then pull entries for a specific session
observability_query_history({
  session_id: "sess-abc-123",
  limit: 100,
})
```

Example curl:

```bash
curl -H "Authorization: Bearer $PI_OBSERVABILITY_API_KEY" \
  "http://localhost:8765/sessions"

curl -H "Authorization: Bearer $PI_OBSERVABILITY_API_KEY" \
  "http://localhost:8765/sessions/sess-abc-123/entries?limit=100"
```

### 4. Query ambient watcher logs

Tool: `observability_query_watcher_logs`

REST endpoint: `GET /watcher_logs`

| Query param | Type | Match |
|-------------|------|-------|
| `level` | string | exact: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `source` | string | exact watcher name (`mismatch_rate_watcher`, `confidence_trend_watcher`, `task_staleness_watcher`, ...) |
| `session_id` | string | exact session UUID |
| `from_ts` / `to_ts` | int | inclusive ms bounds |
| `limit` / `offset` | int | pagination |

Stats endpoint: `GET /watcher_logs/stats`  
Single watcher log: `GET /watcher_logs/{log_id}`

Example tool call:

```typescript
observability_query_watcher_logs({
  source: "mismatch_rate_watcher",
  level: "WARN",
  limit: 50,
})
```

### 5. WebSocket event types

Events the server expects on `ws://host:port/ws`:

```jsonc
// Message plane
{ "event": "session_start",   "sessionId": "...", "timestamp": 1746624000000, "data": { ... } }
{ "event": "message_end",     "sessionId": "...", "timestamp": ..., "data": { ... } }
{ "event": "tool_execution_start", "sessionId": "...", "data": { "tool": "read", ... } }
{ "event": "tool_result",   "sessionId": "...", "data": { "result": ... } }
{ "event": "agent_start",   "sessionId": "...", "data": { "agent": "echo", ... } }
{ "event": "agent_end",     "sessionId": "...", "data": { ... } }
{ "event": "model_select",  "sessionId": "...", "data": { "model": "..." } }
{ "event": "session_shutdown", "sessionId": "...", "data": { ... } }

// Log plane
{ "event": "log", "sessionId": "...", "timestamp": ..., "data": {
  "level": 2,
  "extension": "memory",
  "message": "Bridge timeout after 30s",
  "context": { "tool": "mempalace_search" },
  "error": { "name": "Error", "message": "...", "code": "BRIDGE_TIMEOUT" }
}}

// Watcher log plane
{ "event": "watcher_log", "sessionId": "...", "timestamp": ..., "data": {
  "level": 1,
  "source": "mismatch_rate_watcher",
  "message": "...",
  "context": { ... }
}}
```

### 6. When to query observability

| Symptom | Tool(s) to use |
|---------|----------------|
| An agent returned an error | `observability_query_logs` with `level=ERROR` and the agent's `session_id` |
| Need to reconstruct what happened in a session | `observability_query_history` |
| A signal was expected but not raised | `observability_query_watcher_logs` for the relevant `source` |
| Want overall error trends | `/logs/stats` or `/watcher_logs/stats` |

### 7. Compaction and orchestration endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/compactions` | Ingest a compaction artifact (called by the compaction extension; archive of the full structured artifact whose prose+refs summary went into context) |
| `GET` | `/sessions/{session_id}/compactions` | List archived compaction artifacts for a session (`limit`/`offset`) |
| `GET` | `/sessions/{session_id}/compactions/{compaction_seq}` | Fetch one archived artifact |
| `POST` | `/orchestration/runs` | Ingest engine run upserts (called by the engine's ObsClient) |
| `POST` | `/orchestration/events` | Ingest engine state-transition events |
| `GET` | `/orchestration/runs` | List runs, filterable by `session_id` / `status` |
| `GET` | `/orchestration/runs/{run_id}` | Fetch one run |
| `GET` | `/orchestration/runs/{run_id}/events` | Fetch a run's event stream |
| `GET` | `/sessions/{session_id}/orchestration` | All orchestration activity for a session |

There is no `/checkpoints` endpoint: the engine's durable checkpointer is a separate local SQLite DB (`.penny/orchestration.db`, override `PENNY_ORCH_DB`) that the engine and the compaction extension read directly. Observability's `orchestration_runs`/`orchestration_events` tables are the reporting mirror, not the source of truth.

## Constraints

- `GET /logs`, `/logs/stats`, `/watcher_logs`, `/watcher_logs/stats`, `/sessions`, `/sessions/{id}/entries`, and `/sessions/{id}/search` require Bearer auth when `PI_OBSERVABILITY_API_KEY` is configured.
- `POST /logs`, `POST /watcher_logs`, `POST /compactions`, and the `POST /orchestration/*` endpoints are ingestion endpoints used by extensions and the engine; agents do not call them directly.
- Default retention: `RETENTION_LOG_DAYS=14`, `RETENTION_WATCHER_LOG_DAYS=14`.
- Pagination maximum: 500 rows per request.

## Verification

- [ ] `observability_query_logs` returns JSON with `items`, `total`, `limit`, `offset`.
- [ ] `observability_query_history({ session_id: "..." })` returns chronological entries.
- [ ] `observability_query_watcher_logs` uses `/watcher_logs`, not `/logs`.
- [ ] Timestamps passed to query params are in milliseconds.
- [ ] Combined `logs` + `history` queries share the same `session_id`.

## Files

| File | Purpose |
|------|---------|
| `apps/observability/src/observability/main.py` | FastAPI app, WebSocket handler, REST endpoints |
| `apps/observability/src/observability/db.py` | SQLite DDL and CRUD |
| `apps/observability/src/observability/models.py` | Pydantic request/response models |
| `.pi/extensions/observability/index.ts` | Extension that registers Penny tools and streams events |
| `docs/humans/observability-server/observability-server.md` | Human-facing overview and configuration |
