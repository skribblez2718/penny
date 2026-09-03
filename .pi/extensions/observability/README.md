# Observability Extension

The extension provides two separate surfaces:

- `observability_query_logs` queries bounded structured operational logs from Penny's canonical
  TypeScript observability service.
- `observability_query_history` reads Pi's canonical JSONL session files directly, including
  catalog-bound subagent sessions. It does not depend on the service.

The extension records only small lifecycle custom entries in Pi JSONL and archives completed
compaction summaries. It does not duplicate conversation messages, tool results, or session
transcripts into SQLite and has no WebSocket transport.

## Configuration

| Variable                      | Default                 | Purpose                                                           |
| ----------------------------- | ----------------------- | ----------------------------------------------------------------- |
| `PI_OBSERVABILITY_REST_URL`   | `http://127.0.0.1:8765` | Loopback TypeScript service URL                                   |
| `PI_OBSERVABILITY_API_KEY`    | empty                   | Optional bearer token                                             |
| `PI_OBSERVABILITY_ENABLED`    | `true`                  | Enable service integration                                        |
| `PI_OBSERVABILITY_AUTO_START` | `true`                  | Start the built TypeScript service on `session_start` when absent |

Auto-start coalesces concurrent attempts, marks the service ready only after `GET /health` returns
the expected typed Penny service identity, and allows a later retry after failure. It accepts only a
credential-free loopback HTTP origin and derives the spawned child's bind host/port from
`PI_OBSERVABILITY_REST_URL`. The child receives a least-privilege environment. Startup stderr is
captured only for the bounded readiness window, limited to 16 KiB, stripped of common credentials
and C0/C1 terminal controls before it is included in a warning. An unhealthy child is confirmed
stopped after bounded SIGTERM/SIGKILL escalation.

`PENNY_STATE_ROOT` is the only Penny state-root selector. The service requires explicit Penny state
setup or migration and writes only `$PENNY_STATE_ROOT/observability/observability.db`.

## Development

```bash
# The observability build first builds its orchestration dependency.
bun run --cwd apps/observability build
bun run --cwd .pi/extensions/observability test:all
```
