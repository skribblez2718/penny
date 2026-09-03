# Observability Service

## Contract

Penny uses a reduced TypeScript/Node observability service. Its sole database is
`$PENNY_STATE_ROOT/observability/observability.db`, resolved by the shared Penny state-root module.
The service requires a complete state target explicitly initialized or migrated by an operator.
It opens the current database create-never and never scans, initializes, repairs, migrates, or imports
a legacy location.

The database contains only:

- bounded structured operational logs;
- compaction archive summaries.

It does not contain Pi messages, tool-result transcripts, session mirrors, orchestration mirrors,
or FTS transcript indexes.

## Transport and custody

- Loopback HTTP only; no WebSocket reconnect path.
- Optional bearer authentication.
- Authentication failures and malformed requests are not persisted.
- SQLite WAL/FULL, owner-only directory/file custody, bounded retained rows, bounded WAL, and clean
  shutdown checkpoint.
- The emitted Node server imports the built `@penny/orchestration` export. The observability build
  builds orchestration first, while start verifies both runtime builds. Typecheck/tests resolve the
  dependency source directly to avoid racing a concurrent destructive build.
- Extension auto-start accepts only a credential-free loopback HTTP origin, derives child bind
  host/port from `PI_OBSERVABILITY_REST_URL`, and passes a least-privilege environment.
- Auto-start coalesces concurrent calls and latches ready only after `GET /health` returns the
  expected Penny service identity and schema. Failed attempts remain retryable; unhealthy children
  undergo bounded SIGTERM/SIGKILL escalation with confirmed exit. Startup stderr capture is
  time-bounded, limited to 16 KiB, and stripped of common credentials and C0/C1 terminal controls
  before reporting.

HTTP surface:

- `GET /health`
- `POST /logs`
- `GET /logs`
- `POST /compactions`

## History

`observability_query_history` does not call the service. It uses Pi's exported `SessionManager` to
read canonical Pi JSONL and includes durable catalog-bound
`subagent-sessions/<agent>/*.jsonl`. This preserves message and tool-result bodies within the tool's
explicit output/page limits and remains available with observability stopped.

## Configuration

- `PI_OBSERVABILITY_REST_URL` — service URL; defaults to `http://127.0.0.1:8765`.
- `PI_OBSERVABILITY_API_KEY` — optional bearer key.
- `PI_OBSERVABILITY_ENABLED` — service integration toggle.
- `PI_OBSERVABILITY_AUTO_START` — starts the built TypeScript service on session start.
- `PI_OBSERVABILITY_MAX_ROWS` — bounded structured-log row cap.
- `PI_OBSERVABILITY_HOST` / `PI_OBSERVABILITY_PORT` — loopback bind.
- `PENNY_STATE_ROOT` — sole Penny state-root selector.

Retired variables such as `PI_OBSERVABILITY_URL` and `PI_OBSERVABILITY_DATA_DIR` are not accepted.
