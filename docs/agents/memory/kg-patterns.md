# Knowledge Graph Patterns — Entity relationship conventions

## What

The knowledge graph stores relationships between entities: agents, sessions, decisions, skills, and findings. Use consistent predicates to enable cross-session querying.

## Why

Without a shared relationship vocabulary, KG queries return inconsistent results. Standardized predicates make the graph queryable across time and context.

## Rules

1. **Use canonical predicates.** Do not invent new predicates without updating this document.
2. **Link every completed task.** `memory_kg_add("<Agent>", "completed", "Task:<id>")`
3. **Link every decision.** `memory_kg_add("Penny", "decided", "Decision:<id>")`
4. **Link every session.** `memory_kg_add("Session:<id>", "produced", "Outcome:<id>")`
5. **Invalidate superseded facts.** `memory_kg_invalidate(subject, predicate, object)` when a fact is no longer true.

## Canonical Predicates

| Predicate | Subject | Object | When |
|-----------|---------|--------|------|
| `completed` | Agent name | Task ID | Agent finishes work |
| `decided` | Penny | Decision ID | Consequential action recorded |
| `evaluated` | Penny | Decision ID | Outcome feedback captured |
| `produced` | Session ID | Outcome ID | Session produces result |
| `works_on` | Agent/Penny | Project/Task | Active work assignment |
| `uses` | Agent/Skill | Tool/Extension | Capability declaration |
| `prefers` | User | Setting | Stored preference |

## Constraints

- **Predicates are case-sensitive.** `completed` ≠ `Completed`.
- **Entity names must be consistent.** Use the same string for the same entity across all facts.
- **Invalidate, don't delete.** Use `memory_kg_invalidate` to mark facts as no longer true.

## Verification

- [ ] All completed tasks linked with `completed` predicate
- [ ] All decisions linked with `decided` predicate
- [ ] Superseded facts invalidated, not deleted

## Files

| File | Purpose |
|------|---------|
| `docs/agents/memory/integration.md` | Memory integration patterns |
| `.pi/extensions/memory/index.ts` | Memory extension implementation |
