# Knowledge Graph Patterns — Governed temporal facts

## Scope

The temporal KG is a primary-runtime durable-memory capability. Workers and
skill drivers do not receive KG tools. Every write passes the extension's
predicate allowlist before HTTP dispatch and remains subject to hub-side schema
validation.

## Value gate

Add a fact only when future traversal, provenance, impact analysis, preference
lookup, or temporal invalidation is likely to matter. Do not add facts for
routine turns, ordinary task completion, transient workflow stages, speculative
relationships, or ceremonial agent attribution.

Every changing fact creates an invalidation obligation. Use `memory_kg_invalidate`
when it ends and `memory_kg_supersede` when one governed fact replaces another;
do not delete history.

## Canonical predicate schema v1

| Predicate        | Subject               | Object               | Durable use                                              |
| ---------------- | --------------------- | -------------------- | -------------------------------------------------------- |
| `completed`      | Durable entity        | Durable task/outcome | Consequential completion that future queries will trace. |
| `decided`        | Actor                 | Decision             | Consequential decision.                                  |
| `evaluated`      | Decision/outcome      | Evaluation           | Later result tied to an earlier choice.                  |
| `produced`       | Session/project       | Durable product      | Product provenance.                                      |
| `works_on`       | Actor                 | Project/task         | Changing active assignment.                              |
| `uses`           | Project/capability    | Tool/system          | Durable dependency.                                      |
| `prefers`        | User                  | Setting              | Stable or temporally governed preference.                |
| `explored_by`    | Durable topic         | Agent                | Only when attribution improves later provenance queries. |
| `planned_by`     | Durable plan          | Agent                | Only for reusable plan provenance.                       |
| `critiqued_by`   | Durable product       | Agent                | Only for a review gate later work depends on.            |
| `generated_by`   | Durable artifact      | Agent                | Product provenance.                                      |
| `verified_by`    | Durable claim/product | Verifier             | Verification gate later work depends on.                 |
| `broken_into`    | Durable plan          | Task set             | Reusable decomposition relation.                         |
| `based_on`       | Durable product       | Source artifact      | Derivation/provenance.                                   |
| `generated_from` | Durable artifact      | Source/spec          | Generation provenance.                                   |
| `tested_by`      | Code/finding          | Test/evidence        | Verification trace.                                      |
| `fixes`          | Change                | Finding              | Remediation trace.                                       |
| `follows`        | Durable step          | Prior step           | Stable ordering relation.                                |

The allowlist is case-sensitive. Extending it requires an atomic schema update in
this document, `kg-policy.ts`, hub policy, and tests.

## Entity and temporal rules

- Use one stable entity identifier for the same thing across facts.
- Attach source/provenance accepted by the hub contract.
- Add validity metadata for facts that can change.
- Query `as_of` or timeline data when historical truth matters.
- Invalidate or supersede changed facts; never overwrite history by adding a
  contradictory active edge.

## Verification

- [ ] Write came from the unmarked primary runtime.
- [ ] Relationship passed the future-query value gate.
- [ ] Predicate is in schema v1.
- [ ] Entity identifiers are stable and provenance is present.
- [ ] Changing facts carry temporal lifecycle handling.
- [ ] No routine per-agent, per-file, or per-turn link was created.

## Files

| File                                    | Purpose                     |
| --------------------------------------- | --------------------------- |
| `.pi/extensions/memory/kg-policy.ts`    | Client-side exact allowlist |
| `docs/humans/memory/knowledge-graph.md` | Human rationale             |
| `docs/agents/memory/integration.md`     | Primary memory policy       |
