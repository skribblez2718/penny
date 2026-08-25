# Penny Observability Service

Penny's current observability service is implemented in TypeScript and stores only bounded
structured operational logs plus compaction archives. Its database is resolved through the shared
Penny state root and lives at `observability/observability.db`.

The server binds to loopback HTTP and exposes health, structured-log query/ingest, and compaction
archive ingest. It has no WebSocket, message/session transcript, FTS, or orchestration mirror plane.
Authentication failures and malformed events are rejected without creating rows.

Conversation and tool history remains Pi-owned. `observability_query_history` reads Pi JSONL
through Pi's exported session APIs and adds catalog-bound durable subagent session directories.
Therefore history remains usable when the observability server is unavailable.

See `apps/observability/README.md` for commands and `.env.example` for the current configuration
surface.
