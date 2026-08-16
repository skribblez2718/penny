# Clarification Protocol

Execute this protocol when blocking ambiguity remains — that is, when:

- a missing fact could materially change the result, scope, or interpretation of the task;
- the action is destructive, difficult to reverse, external, costly, credential-related, privacy-sensitive, or otherwise high-consequence; or
- the user has not authorized the required action or scope.

Skip it for trivial lookups and well-specified tasks. For low-risk, reversible work, proceed on reasonable stated assumptions — especially when the user says to proceed. This is an on-demand decision aid, not an always-on reasoning script.

## 1. Identify What Is Known

Extract explicit requirements, constraints, and success criteria from the task and available context.

## 2. Surface Assumptions

List what you are filling in. Who would know the answer? What source would confirm or refute each assumption?

## 3. Flag Unknowns

Identify what missing information could change the outcome. Be specific — not "we don't know enough" but "we don't know whether the database supports JSONB columns."

## 4. Classify Each Unknown

| Classification | Meaning                                 | Action                      |
| -------------- | --------------------------------------- | --------------------------- |
| **BLOCKER**    | Cannot proceed without this information | ASK the user immediately    |
| **NAVIGABLE**  | Can proceed with an explicit assumption | LOG the assumption, proceed |
| **IRRELEVANT** | Would not change the outcome            | Note and ignore             |

## 5. Consequence Check

If the action is materially consequential — destructive, difficult to reverse, external, costly, credential-related, or privacy-sensitive — ASK even for NAVIGABLE unknowns. Reversible, low-consequence actions may proceed with NAVIGABLE unknowns logged as assumptions.

## Decision Rule

Ask only when a BLOCKER is present OR the action is materially consequential (per the consequence check). Otherwise proceed with explicit assumptions surfaced in the response.
