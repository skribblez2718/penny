# Penny Observability Service

Penny's current observability service is implemented in TypeScript and stores only bounded
structured operational logs plus compaction archives. Its database is resolved through the shared
Penny state root and lives at `observability/observability.db`.

The server binds to loopback HTTP and exposes health, structured-log query/ingest, and compaction
archive ingest. It requires a complete Penny state target created by explicit setup or migration and
opens its database without creating or upgrading it. It has no WebSocket, message/session transcript,
FTS, or orchestration mirror plane. Authentication failures and malformed events are rejected without
creating rows. Its build command builds orchestration first, its start command verifies both runtime
builds, and the emitted Node server consumes the built package rather than its TypeScript source
export. Typecheck and unit tests resolve orchestration source so a separate build cannot temporarily
remove their dependency.

Conversation and tool history remains Pi-owned. `observability_query_history` reads Pi JSONL
through Pi's exported session APIs and adds catalog-bound durable subagent session directories.
Therefore history remains usable when the observability server is unavailable.

Automatic startup shares one in-flight attempt, accepts only a credential-free loopback HTTP origin,
and derives the child's bind address from that endpoint. It considers the service started only after
the health response identifies the expected Penny service and schema, and it can retry after failure.
The child receives a least-privilege environment. Startup stderr is collected only within fixed time
and byte limits, with common credentials and C0/C1 terminal controls removed before a warning is
shown; a spawned process that never becomes healthy is confirmed stopped after bounded escalation.

See `apps/observability/README.md` for commands and `.env.example` for the current configuration
surface.
