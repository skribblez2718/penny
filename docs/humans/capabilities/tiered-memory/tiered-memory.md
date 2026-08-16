# Tiered Memory

Penny separates active context from durable knowledge and cold archive:

| Tier | Content                                                                            |
| ---- | ---------------------------------------------------------------------------------- |
| T0   | Stable frame/identity.                                                             |
| T1   | Current conversation plus compact run state and selected artifact refs.            |
| T2   | Recent primary diary and warm classified data.                                     |
| T3   | Curated decisions, architecture, reusable knowledge, preferences, and temporal KG. |
| T4   | Cold archive / legacy corpus.                                                      |

Only the unmarked primary runtime has memory tools. Recall is explicit and
relevance-driven; writes are curated; the primary diary is bounded; KG facts are
allowlisted and temporally governed. Workers and skill drivers have no memory
tools.

Active workflow bytes live in owner artifacts, not memory. Workers read exact
grants with `artifact_read` and typed continuation. Historical skill rooms are
legacy corpus and never deletion authority.

Normal memory access uses one supervised MemPalace 3.7.1 HTTP hub with no raw
fallback. Offline access is copy-only and receipt-gated. Setup, cutover, and
uninstall preserve caller-owned data.

## Learn more

- `docs/agents/architecture/tiered-memory.md`
- `docs/agents/memory/integration.md`
