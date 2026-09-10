# Tiered Memory

Penny separates active context from durable knowledge and cold archive:

| Tier | Content                                                                            |
| ---- | ---------------------------------------------------------------------------------- |
| T0   | Stable frame/identity.                                                             |
| T1   | Current conversation plus compact run state and selected artifact refs.            |
| T2   | Recent primary diary and warm classified data.                                     |
| T3   | Curated decisions, architecture, reusable knowledge, preferences, and temporal KG. |
| T4   | Cold archive / legacy corpus.                                                      |

The unmarked primary runtime owns the full memory surface. Recall is explicit
and relevance-driven; writes are curated; the primary diary is bounded; KG facts
are allowlisted and temporally governed. A catalog worker may receive an
owner-granted, YAML-declared bounded read-only recall/KG bundle, but never writes,
lifecycle hooks, advisory-log access, or memory-based handoff. Skill drivers have
no memory tools. A default-off primary advisory log may add only bounded,
strictly self-addressed append/list/wait/ack; raw upstream broadcasts fail
closed. Its bounded free-form body can technically contain arbitrary small text.
Dedicated artifact/patch endpoints and refs are absent, and policy makes the
body non-authoritative: it is never consumed as artifact handoff, workflow
state, a persistence receipt, or recovery input.

Active workflow bytes live in owner artifacts, not memory. Workers read exact IDs with `artifact_read` and `next_range`. Historical skill rooms are
legacy corpus and never deletion authority.

Normal memory access uses one supervised MemPalace 3.7.1 HTTP hub with no raw
fallback. Generic memory clients continue to forbid logstream access; Penny's
narrow advisory surface lives only in the primary extension and pins routing to
trusted configuration. Offline access is copy-only and receipt-gated. Setup,
cutover, and uninstall preserve caller-owned data.

## Learn more

- `docs/agents/architecture/tiered-memory.md`
- `docs/agents/memory/integration.md`
