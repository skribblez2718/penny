# Tiered Memory — Primary durable recall with artifact-first workflow state

## Tier map

| Tier | Content                                                                       | Access                                                 |
| ---- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| T0   | Cognitive Frame and stable identity                                           | Always in prompt.                                      |
| T1   | Current conversation, compact run state, selected artifact refs               | Active context/checkpointer.                           |
| T2   | Recent primary diary and explicitly classified warm data                      | Bounded primary recall when relevant.                  |
| T3   | Curated architecture, decisions, preferences, reusable knowledge, temporal KG | Explicit primary retrieval.                            |
| T4   | Cold archived legacy/scratch corpus                                           | Offline/manual recovery; never automatic prompt input. |

Exact workflow stage bytes are not a memory tier. They live in the immutable
artifact plane; `RunContext` stores only compact refs and routing state.

## Rules

1. Only the unmarked primary runtime has memory tools and lifecycle hooks.
2. Primary T2/T3 recall is value-triggered, bounded, provenance-aware, and advisory.
3. Workers and skill drivers have no memory tools or instructions.
4. Active workflow handoff uses owner grants plus `artifact_read`; large reads use
   typed continuation until complete.
5. Curated writes preserve stable reusable knowledge only. The write path enforces
   duplicate rejection; no routine precheck is required.
6. The primary diary may retain one bounded session entry. Workers never write diaries.
7. Temporal KG writes are allowlisted and value-gated; changed facts are
   invalidated/superseded, not deleted.
8. T4 is never prompt-injected.

## Retention and legacy corpus

Historical `skills/<skill>-<session_id>` rooms and retired dedicated skill wings
are legacy corpus, not active handoff. `skill_rooms.json` is classification input
to a dry-run planner, not a live registry or deletion authority. Unknown data is
kept. Apply requires a reviewed immutable manifest, archive-first behavior, and
an operation journal through the supervised HTTP hub.

## Service boundary

One authenticated supervised MemPalace 3.7.1 HTTP hub owns normal writable
access. Production, admin, eval, and retention paths have no raw/direct fallback.
Offline raw access is limited to a drained, stopped, receipt-bound copied target.
Setup, cutover, and uninstall preserve caller-owned data; deletion is separate.

## Compaction

Conversation compaction is not T4. The compaction summary carries a concise prose
orientation and optional code-owned exact run/artifact refs. Resume from the run
checkpoint and granted artifacts; memory absence does not block continuation.

## Verification

- [ ] Workers expose no memory tools.
- [ ] Workflow handoff/recovery is exact-artifact based.
- [ ] Primary recall and writes pass durable-value gates.
- [ ] Diary and KG writes are primary-only and governed.
- [ ] Legacy corpus labels cannot authorize deletion.
- [ ] One supervised 3.7.1 HTTP hub; no raw fallback.
- [ ] Uninstall preserves data.
