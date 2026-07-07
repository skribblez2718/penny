# Tiered Memory — Five-tier context management across session lifetime

## What

Memory is organized into five tiers by lifetime and injection priority. T0 (identity) is always injected. T1 (active session) is in conversation context. T2 (working memory) is pre-turn injected. T3 (reference) is on-demand RAG. T4 (archive) is search-only.

## Why

Without tiering, every memory competes for the same context window. Tiering ensures recent, high-signal memories get priority injection while reference material stays out of the way until needed.

## Rules

1. **T0 is immutable without review gate.** SYSTEM.md changes require amendment pipeline → user approval.
2. **T2 injection is bounded.** Pre-turn smart search returns ≤5 results, ≤4,000 tokens.
3. **T3 is never pre-injected.** Reference material loads only on explicit agent request.
4. **T4 is never injected.** Archive is search-only.
5. **Store before you lose it.** If information would be lost on compaction, write it to mempalace first.

## Tier Map

| Tier | Content | Lifetime | Injection |
|------|---------|----------|-----------|
| **T0** | SYSTEM.md — identity, rules, vocabulary | Permanent | Always (Pi system prompt) |
| **T1** | Current conversation, FSM state, active task | Session (hours) | Always (in context) |
| **T2** | Recent outcomes, diary, pending signals | 7–30 days | Pre-turn smart search |
| **T3** | Architecture docs, decisions, KG facts | Permanent | On-demand RAG |
| **T4** | Old sessions, expired outcomes, old versions | 90+ days | Search only |

## Room → Tier Convention

| Room | Tier | Rationale |
|------|------|-----------|
| `penny/outcomes` | T2 | Recent outcomes drive pre-turn injection |
| `penny/diary` | T2 | Recent entries are working memory |
| `penny/signals` | T2 | Pending signals need attention |
| `penny/architecture` | T3 | Permanent reference |
| `penny/decisions` | T3 | Permanent reference |
| `penny/skills` | T3 | Completed skill summaries |
| `penny/system_versions` | T4 | Archive only |
| `penny/audit` | T4 | 90-day post-hoc |

## Distillation Pipeline

| Transition | Trigger | Action |
|-----------|---------|--------|
| T1 → T2 | Session end | Write diary entry, outcome records |
| T2 → T3 | 30 days / pattern detected | Age out of pre-turn window; extract KG patterns |
| T3 → T4 | 90 days / explicit completion | Mark superseded; move to archive rooms |

## Constraints

- **T0 size ceiling:** 2,500 tokens. Net delta ≤ 0 per amendment cycle.
- **T2 injection budget:** ≤4,000 tokens per pre-turn query.
- **T3 is never pre-injected.** Violating this bloats context with stale reference material.
- **Pi native compaction is T4.** Do not duplicate it — supplement it by storing critical information in mempalace.

## Verification

- [ ] T0 ≤ 2,500 tokens
- [ ] T2 pre-turn injection returns ≤5 results
- [ ] No T3 content in pre-turn injection
- [ ] Distillation pipeline runs at session end

## Files

| File | Purpose |
|------|---------|
| `docs/agents/capabilities/tiered-memory/tiered-memory.md` | Agent operational guide |
| `scripts/system/tiered_memory/archiver.py` | T3→T4 archival |
| `plans/ai-gaps-resolution/02-designs/09-tiered-memory.md` | Design doc |
