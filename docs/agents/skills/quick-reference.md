# Skill Quick Reference — Artifact-first build checklist

Optional navigation for authors; it adds no requirements beyond the linked owners.

## Design

- Warrant durable state, gates, repair, fan-out, or resume—not a minimum worker count.
- Name the failure/dependency each state and ordering rule addresses.
- Resolve shared decisions before consumers; bound loops and gate consequences.
- Use [Design Methodology](design-methodology.md) and, when drawing the required mirror,
  [Flow Diagrams](flow-diagrams.md). Diagram-first is optional; final descriptor agreement is not.

## Build

1. Implement and register a TypeScript `PlaybookCore` per [Skill Standard](skill-standard.md).
2. Use [SKILL.md Format](skill-md-format.md) and its [template](skill-md-template.md) for YAML,
   visibility, and content boundaries.
3. Supply state-specific prompts, exact artifact contracts, README/reference and `resources/flow.html`.
4. Follow [Invocation](../agents/invocation.md) for exact transport/capture and
   [Skill Orchestration](orchestration.md) for checkpoint/admission deltas.

## Validate

Use the [testing evidence matrix](testing.md#required-coverage), including applicable negative,
recovery, composition, package/clean-pack and source-guard checks. Record what actually ran and
its scope; neither a checklist nor an existing assertion establishes a pass.

## Common mistakes

- Reintroducing `state_machine: true`, argv state, an executable skill delegate, or a room requirement.
- Passing predecessor text inline, discovering missing predecessors, or truncating instead of
  continuing `next_range`.
- Treating a SUMMARY, model locator, or memory write as persistence proof.
- Adding generic SUMMARY keys rejected by the active closed phase schema.
- Giving workers memory-write/logstream tools or using memory for workflow handoff.

## Files

| File                                      | Purpose              |
| ----------------------------------------- | -------------------- |
| [Skill Standard](skill-standard.md)       | Requirements         |
| [Testing](testing.md)                     | Evidence matrix      |
| `scripts/tools/scaffold-skill.py`         | Canonical scaffolder |
| `scripts/tools/templates/skill-flow.html` | Safe flow frame      |
