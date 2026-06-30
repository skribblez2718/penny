# Penny Reference Protocols

Procedural documents referenced by SYSTEM.md directives. These are loaded via `read` only when their trigger condition is met — they are not burned into context on every turn.

| Document | Trigger | Purpose |
|----------|---------|---------|
| [Clarification Protocol](clarification-protocol.md) | Ambiguity Gate activated | 5-step protocol: identify knowns, surface assumptions, flag unknowns, classify (BLOCKER/NAVIGABLE/IRRELEVANT), irreversibility check |
| [Compaction Protocol](compaction-protocol.md) | `[COMPACT-ARTIFACT]` in context | Parse artifact, handle pending state, retrieve missing context, budget awareness |

## Design Pattern

These docs follow the **extraction pattern**: content that is only situationally needed is extracted from SYSTEM.md into a reference file. SYSTEM.md contains only a trigger directive ("If you see X, execute the protocol at `docs/penny/Y.md`"). This saves context tokens on every turn while keeping knowledge available when needed.
