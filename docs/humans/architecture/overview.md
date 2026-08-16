# Penny's Architecture: A Human Overview

Penny combines five prompt layers, project-local worker roles, a checkpointed
workflow engine, an immutable artifact plane, and optional primary durable memory.

## The major boundaries

- **`.pi/agents` is the local catalog.** Remote harness/service presence belongs
  to a separate registry.
- **Artifacts carry exact current-run handoff.** Owners grant refs, workers read
  with `artifact_read`, and owners capture/verify complete responses before
  routing SUMMARY data.
- **The checkpointer carries control state.** It stores compact fields and selected
  refs, never stage payload bytes.
- **Memory carries durable cross-session knowledge.** Only the unmarked primary
  runtime recalls or curates it; workers and skill drivers have no memory tools.

## Context and recovery

Typed continuation keeps large artifact and memory reads bounded without silent
truncation. Retry, clarification, restart, and partial fan recovery reuse exact
checkpointed refs. Conversation compaction preserves a prose orientation and
optional code-owned exact run/artifact refs, so active work can continue without
semantic discovery.

## Memory service

Normal memory access uses one authenticated, supervised MemPalace 3.7.1 HTTP
hub. Production and online admin paths have no raw fallback. Offline repair is
copy-only and receipt-gated. Setup, cutover, and uninstall preserve caller-owned
data unless deletion is separately authorized.

## Related documents

- [Project Standards](project-standards.md)
- [Tiered Memory](tiered-memory.md)
- [Skill Tool Modes](skill-tool-modes.md)
- [Prompt Architecture](../prompts/overview.md)
