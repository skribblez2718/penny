# Error Codes — Structured error taxonomy for all extensions

## What

Every structured log entry includes an `error.code` from a centralized taxonomy. Codes are `SCREAMING_SNAKE_CASE`, prefixed by subsystem. Source of truth: `.pi/lib/logger/logger.ts` `ErrorCode` union type.

## Why

Without a shared taxonomy, error logs are inconsistent strings. With it, observability queries can filter by subsystem and severity, and agents can pattern-match error codes to known failure modes.

## Rules

1. **All error logs must include a code from the taxonomy.** No ad-hoc error strings.
2. **New codes must be added to the `ErrorCode` union type first**, then documented here.
3. **Severity follows the logger convention:** DEBUG, INFO, WARN, ERROR, CRITICAL.

## Code Reference

| Code | Severity | Extension | Description |
|------|----------|-----------|-------------|
| `BRIDGE_TIMEOUT` | ERROR | memory | Bridge process hung >30s |
| `BRIDGE_SPAWN_ERROR` | ERROR | memory | Failed to spawn bridge |
| `BRIDGE_PARSE_ERROR` | WARN | memory | Bridge stdout not valid JSON |
| `PYTHON_TIMEOUT` | ERROR | skill | Orchestrator timed out |
| `PYTHON_SPAWN_ERROR` | ERROR | skill | Failed to spawn orchestrator |
| `PYTHON_PARSE_ERROR` | WARN | skill | Orchestrator stdout not valid JSON |
| `AGENT_TIMEOUT` | ERROR | agent-runner | Agent subprocess timed out |
| `AGENT_SPAWN_ERROR` | ERROR | agent-runner | Failed to spawn agent |
| `AGENT_INCOMPLETE` | WARN | agent-runner | Agent exited without `message_end` |
| `COMPACTION_MEMPALACE_QUERY_FAILED` | ERROR | compaction | Mempalace query failed |
| `COMPACTION_KG_QUERY_FAILED` | ERROR | compaction | KG query failed |
| `COMPACTION_VALIDATION_FAILED` | ERROR | compaction | Artifact failed zod validation |
| `SEARCH_API_KEY_MISSING` | ERROR | search | `OLLAMA_API_KEY` not set |
| `SEARCH_CLIENT_ERROR` | WARN | search | HTTP 4xx from search API |
| `SEARCH_SERVER_ERROR` | ERROR | search | HTTP 5xx from search API |
| `OBSERVABILITY_WS_ERROR` | ERROR | observability | WebSocket connection error |
| `OBSERVABILITY_QUEUE_OVERFLOW` | WARN | observability | Message queue hit limit |

## Adding a Code

1. Add to `ErrorCode` union in `.pi/lib/logger/logger.ts`
2. Add row to table above
3. Update `scripts/system/checks/check_error_logging.py` if needed

## Verification

- [ ] All `logger.error()` calls use a code from the taxonomy
- [ ] New codes added to both logger.ts and this document
- [ ] Severity matches logger convention

## Files

| File | Purpose |
|------|---------|
| `.pi/lib/logger/logger.ts` | `ErrorCode` union type (source of truth) |
