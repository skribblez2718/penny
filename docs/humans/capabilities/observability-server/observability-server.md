# Observability

Penny keeps operational diagnostics separate from conversation history.

The observability service is a small TypeScript/Node loopback HTTP service backed by the canonical
Penny state database `observability/observability.db`. It stores bounded structured logs and
compaction summaries only. It does not copy conversations, tool results, orchestration state, or Pi
sessions into another database.

Conversation history comes directly from Pi's append-only JSONL sessions. The history tool also
finds Penny's durable, project-bound subagent sessions, and it continues to work when the
observability service is stopped.

This design removes the former Python server, WebSocket reconnect loop, duplicate transcript and
orchestration mirror tables, and per-event authentication-failure persistence. The remaining
service uses owner-only SQLite custody, WAL/FULL durability, bounded retention, clean shutdown, and
an optional bearer key on loopback HTTP.
