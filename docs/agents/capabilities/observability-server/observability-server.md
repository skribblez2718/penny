# Observability Server — Capability Reference

## What

The observability server is a FastAPI + SQLite backend that ingests real-time events and structured log entries from all Penny extensions. It provides a queryable REST API for session history, operational logs, and watcher signals.

## Why

Without observability, agent failures are silent. The server provides the diagnostic surface for debugging agent behavior, tracking session lifecycle, and surfacing watcher signals.

## Rules

1. **Query before assuming.** When debugging agent or extension behavior, query `observability_query_logs` for errors before speculating.
2. **Use session_id for scoping.** Always filter by `session_id` when investigating a specific session's behavior.
3. **Watcher logs are separate.** Use `observability_query_watcher_logs` for ambient watcher diagnostics — these are kept logically separate from general operational logs.
4. **Retention is 14 days.** Do not rely on observability data for long-term storage — use mempalace for persistence.

## Query Tools

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `observability_query_logs` | Query operational logs | `level`, `component`, `session_id`, `from_ts`, `to_ts`, `limit`, `offset` |
| `observability_query_history` | Query conversation history | `session_id`, `limit`, `offset` |
| `observability_query_watcher_logs` | Query ambient watcher logs | `source`, `level`, `session_id`, `from_ts`, `to_ts`, `limit`, `offset` |

## Log Levels

| Integer | Level | When |
|---------|-------|------|
| 0 | DEBUG | Verbose diagnostic output |
| 1 | INFO | Normal operation events |
| 2 | WARN | Unexpected but non-fatal |
| 3 | ERROR | Operation failed |
| 4 | CRITICAL | System-level failure |

## When to Query

- **Agent misbehavior:** Query logs by `session_id` with `level >= 2` to find errors.
- **Extension issues:** Query logs by `component` matching the extension name.
- **Watcher signals:** Query watcher logs by `source` (e.g., `mismatch_rate_watcher`, `confidence_trend_watcher`).
- **Session reconstruction:** Query history by `session_id` to see full conversation flow.

## Constraints

- **Max 500 results per query.** Use `offset` for pagination.
- **Timestamps are milliseconds since epoch.** Use `from_ts` and `to_ts` for time-bounded queries.
- **Watcher logs are not in general logs.** They must be queried separately.

## Files

| File | Purpose |
|------|---------|
| `docs/agents/observability-server/observability-server.md` | Full API reference (REST endpoints, WebSocket events, DB schema) |
| `apps/observability/src/observability/` | Server implementation |
| `.pi/extensions/observability/` | Extension that registers query tools |