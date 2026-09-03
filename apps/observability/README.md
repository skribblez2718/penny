# Penny Observability

Penny's observability backend is a reduced TypeScript/Node service. It stores bounded structured
operational logs and compaction archives in the canonical global Penny state database:

```text
$PENNY_STATE_ROOT/observability/observability.db
```

Complete Penny state must already have been created by explicit setup or migration (`penny-state
init` provisions this database). The service opens the existing current schema create-never; it does
not initialize, repair, migrate, or import the retired Python observability database.

## Commands

```bash
bun run --cwd apps/observability typecheck
bun run --cwd apps/observability test
bun run --cwd apps/observability build
bun run --cwd apps/observability start
```

The observability **build** command builds `@penny/orchestration` first; the start command verifies
both runtime builds are present. Typecheck and unit tests resolve orchestration source directly so
they cannot race a separate build that replaces `dist`. The emitted Node service imports the built
package export and never loads the orchestration TypeScript source export at runtime.

The server binds to loopback, defaults to `127.0.0.1:8765`, uses WAL/FULL SQLite, bounds retained
log rows, and checkpoints on clean shutdown. Authentication failures and malformed requests are
not persisted.

## HTTP surface

- `GET /health`
- `POST /logs`
- `GET /logs`
- `POST /compactions`

Conversation history is intentionally absent. `observability_query_history` reads Pi's canonical
JSONL files directly and includes catalog-bound durable subagent sessions, so history remains
available while this service is stopped.

Extension auto-start uses one shared in-flight attempt, confirms the typed Penny identity returned
by `GET /health` before latching ready, and retries after failure. Auto-start requires a credential-free
loopback HTTP origin and derives the child bind host/port from `PI_OBSERVABILITY_REST_URL`; manual
`start` continues to use `PI_OBSERVABILITY_HOST` and `PI_OBSERVABILITY_PORT`. The child receives only
the state, observability, locale, and required OS path variables it needs. Auto-start captures at most
16 KiB of startup stderr during the bounded readiness window, redacts common credentials and C0/C1
terminal controls before reporting it, and confirms termination of an unhealthy spawn after bounded
SIGTERM/SIGKILL escalation.
