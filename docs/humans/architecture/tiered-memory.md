# Tiered Memory: What Penny Remembers

## The tiers

| Tier | Content                                                                       | Access                            |
| ---- | ----------------------------------------------------------------------------- | --------------------------------- |
| T0   | Stable frame and identity                                                     | Always present.                   |
| T1   | Current conversation, compact run state, selected artifact refs               | Current context/checkpointer.     |
| T2   | Recent primary diary and warm classified data                                 | Explicit relevant primary recall. |
| T3   | Curated decisions, architecture, preferences, reusable knowledge, temporal KG | Explicit primary recall.          |
| T4   | Cold archive and legacy corpus                                                | Manual offline recovery only.     |

Exact workflow stage output is not memory: it lives in immutable owner artifacts.
Workers read exact grants with `artifact_read`; the checkpointer retains refs.

## Runtime ownership

Only the unmarked primary runtime has durable-memory tools. It recalls prior
knowledge when it could materially affect a task, curates only stable reusable
results, writes the primary diary, and governs temporal KG facts. Workers and
skill drivers have no memory tools.

## Retention

Historical skill rooms are legacy corpus, not active handoff. Their
classification file can help a dry-run planner but cannot authorize deletion.
Unknown data is kept. Apply requires a reviewed immutable hash-bound manifest,
archive-first behavior, and an operation journal through the supervised hub.

## Service and preservation

One supervised MemPalace 3.7.1 HTTP hub owns normal access. Production and online
admin paths have no raw fallback. Offline repair is restricted to a drained,
stopped, receipt-bound copy. Setup, cutover, and uninstall preserve data;
deletion is separate.

## Compaction

Conversation compaction is context management, not T4 archival. It preserves a
prose brief and optional exact run/artifact refs for context-safe continuation.
Memory availability does not block active-run recovery.

## Related documents

- Agent architecture: `docs/agents/architecture/tiered-memory.md`
- Capability guide: `docs/humans/capabilities/tiered-memory/tiered-memory.md`
