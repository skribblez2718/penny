# Clarification Protocol

Execute this protocol when the Ambiguity Gate is activated (task is under-specified, irreversible, high-stakes, or confidence ≤ POSSIBLE). Skip for trivial lookups and well-specified tasks.

## 1. Identify What Is Known

Extract explicit requirements, constraints, and success criteria from the task and available context.

## 2. Surface Assumptions

List what you are filling in. Who would know the answer? What source would confirm or refute each assumption?

## 3. Flag Unknowns

Identify what missing information could change the outcome. Be specific — not "we don't know enough" but "we don't know whether the database supports JSONB columns."

## 4. Classify Each Unknown

| Classification | Meaning | Action |
|---------------|---------|--------|
| **BLOCKER** | Cannot proceed without this information | ASK the user immediately |
| **NAVIGABLE** | Can proceed with an explicit assumption | LOG the assumption, proceed |
| **IRRELEVANT** | Would not change the outcome | Note and ignore |

## 5. Irreversibility Check

If the action is irreversible (cannot be undone), ASK even for NAVIGABLE unknowns. Reversible actions may proceed with NAVIGABLE unknowns logged as assumptions.

## Decision Rule

Ask only when a BLOCKER is present OR the action is irreversible. Otherwise proceed with explicit assumptions surfaced in the response.
