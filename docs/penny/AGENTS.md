# Penny Reference Protocols

Procedural documents referenced by SYSTEM.md directives. These are loaded via `read` only when their trigger condition is met — they are not burned into context on every turn.

| Document | Trigger | Purpose |
|----------|---------|---------|
| [Clarification Protocol](clarification-protocol.md) | Ambiguity Gate activated | 5-step protocol: identify knowns, surface assumptions, flag unknowns, classify (BLOCKER/NAVIGABLE/IRRELEVANT), irreversibility check |
| [Compaction Resume Protocol](compaction-protocol.md) | `[RESUME-REFS v2]` block in context | Reorient from the prose brief, resume engine runs via the checkpointer refs, dereference memory pointers on demand |
| [Routing & Delegation Protocol](routing-protocol.md) | Constructing a delegation to a skill/agent | Engine-skill internals, the `Task \| Context \| Sources \| Constraints` hand-off format, agent escalation |
| [Tool Usage](tool-usage.md) | Need the tool reference or file-handling tactics | Core tool list + `edit`/`grep`/`write` tactics (the always-on "no output files in the project tree" rule stays inline in SYSTEM.md) |

## Design Pattern

These docs follow the **extraction pattern**: content that is only situationally needed is kept out of the always-on Cognitive Frame (`.pi/SYSTEM.md`) and lives here, loaded on demand via `read` when its trigger fires.

SYSTEM.md names each protocol by its **trigger only** ("run the clarification protocol") and carries **no file path** — this table is the single source of truth for the paths. The root `AGENTS.md` (always in context) points here, so Penny resolves *trigger → this index → the protocol file*. Keeping paths in the AGENTS.md index chain — never in SYSTEM.md — is what prevents the Cognitive Frame from accreting reference links and bloating over time.
