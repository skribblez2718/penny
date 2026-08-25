# Penny Observability

Penny's observability backend is a reduced TypeScript/Node service. It stores bounded structured
operational logs and compaction archives in the canonical global Penny state database:

```text
$PENNY_STATE_ROOT/observability/observability.db
```

The project catalog and state directories must already have been created by explicit setup or
migration. The service never imports or opens the retired Python observability database.

## Commands

```bash
bun run --cwd apps/orchestration build
bun run --cwd apps/observability typecheck
bun run --cwd apps/observability test
bun run --cwd apps/observability build
bun run --cwd apps/observability start
```

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
