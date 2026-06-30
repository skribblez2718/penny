# Tiered Memory — Five-tier context management for agents

## What

Memory is organized into five tiers. T0 (identity) is always injected. T1 (active session) is in conversation. T2 (working) is pre-turn injected. T3 (reference) is on-demand. T4 (archive) is search-only.

## Why

Without tiering, every memory competes for the same context window. Tiering ensures recent, high-signal memories get priority.

## Rules

1. **T2 injection is bounded.** Pre-turn smart search: ≤5 results, ≤4,000 tokens.
2. **T3 is never pre-injected.** Load reference material only on explicit request.
3. **T4 is never injected.** Archive is search-only.
4. **Store before compaction.** If information would be lost when Pi compacts conversation, write it to mempalace first.

## Tier Map

| Tier | Content | Injection | Trigger |
|------|---------|-----------|---------|
| T0 | SYSTEM.md | Always | Pi session start |
| T1 | Current conversation, FSM state | Always | In context |
| T2 | Recent outcomes, diary, signals | Pre-turn | `memory_smart_search` every message |
| T3 | Architecture docs, decisions, KG | On-demand | Agent `read` or `memory_smart_search` |
| T4 | Old sessions, expired outcomes | Search only | Explicit broad query |

## Injection Protocol

| Tier | Query |
|------|-------|
| T2 | `memory_smart_search(query="outcome ledger recent MISMATCH", wing="penny", room="outcomes", limit=5)` |
| T3 | `memory_smart_search` + `memory_kg_query` + AGENTS.md traversal |
| T4 | `memory_smart_search` with broad queries |

## Distillation

| Transition | Trigger | Action |
|-----------|---------|--------|
| T1 → T2 | Session end | `memory_diary_write` |
| T2 → T3 | 30 days | Age out of pre-turn window |
| T3 → T4 | 90 days / completed | `scripts/system/tiered_memory/archiver.py` |

## Constraints

- **T0 ceiling:** 2,500 tokens
- **T2 budget:** ≤4,000 tokens per injection
- **T3 is never pre-injected**
- **Pi native compaction is T4** — supplement, don't duplicate

## Verification

- [ ] T2 injection returns ≤5 results
- [ ] No T3 content in pre-turn injection
- [ ] Diary written at session end

## Files

| File | Purpose |
|------|---------|
| `docs/agents/architecture/tiered-memory.md` | Full architecture |
| `scripts/system/tiered_memory/archiver.py` | T3→T4 archival |
