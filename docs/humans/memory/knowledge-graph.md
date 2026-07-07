# Penny's Knowledge Graph

The knowledge graph is the part of Penny's memory that stores relationships between things, not just the things themselves. While drawers hold verbatim notes, the graph answers questions like "what did Penny decide about X?" and "which sessions produced this artifact?"

## What the Knowledge Graph Is

At its core, the graph is a collection of simple facts in the form:

> **subject → predicate → object**

Each fact links two entities. The entities can be anything Penny needs to reason about: agents, sessions, decisions, skills, tasks, tools, or preferences. The predicate describes the relationship between them.

Examples of facts:

| Subject | Predicate | Object | Meaning |
| --- | --- | --- | --- |
| `Penny` | `works_on` | `Project:Penny` | Penny is actively involved with the project. |
| `Session:2026-04-09` | `produced` | `File:auth.py` | A session produced a specific file. |
| `Penny` | `decided` | `Decision:use-transitions` | Penny recorded a consequential decision. |
| `User` | `prefers` | `dark_mode` | A user preference was learned. |

Each fact can also carry a `valid_from` date. This makes the graph temporal: you can ask what was true at a specific moment, not just what is true right now.

## Why a Graph, Not Just Search?

Semantic search finds notes that *sound like* the query. That is powerful but fuzzy. The graph provides precision that search alone cannot:

- **Exact linkage** — a decision is linked to the session that produced it, not merely mentioned in the same paragraph.
- **Cross-session continuity** — work done last month can be connected to work done today through shared entities.
- **Temporal reasoning** — you can ask "what did Penny believe on April 1st?" and get the facts that were valid then.
- **Relationship discovery** — you can walk outward from an entity to find related decisions, artifacts, and preferences without guessing keywords.

The two systems complement each other. Search is good for "find me things about authentication." The graph is good for "what decisions about authentication has Penny made, and which of them are still valid?"

## Entities and Predicates

An **entity** is any node in the graph. Entity names should be consistent: if one fact uses `Skill:TDD` and another uses `TDD_Skill`, they are treated as different things. The convention is to namespace entities so their type is obvious:

- `Penny` — the agent itself.
- `Session:<id>` — a specific execution session.
- `Decision:<id>` — a recorded decision.
- `Skill:<name>` — a skill definition.
- `Task:<id>` — a task or issue.
- `Feature:<name>` — a product feature.
- `File:<path>` — an artifact file.

A **predicate** is a small, controlled vocabulary of relationship types. Using a shared set of predicates keeps queries predictable. The canonical predicates include:

| Predicate | Meaning | Typical Use |
| --- | --- | --- |
| `works_on` | Active involvement or assignment | Agent works on project or task. |
| `uses` | Tool or capability usage | Skill uses a library or extension. |
| `prefers` | Learned preference | User prefers a setting or style. |
| `decided` | Consequential decision | Agent recorded a decision. |
| `owns` | Ownership | User owns a project. |
| `assigned_to` | Task delegation | Task assigned to agent or human. |
| `completed` | Completion | Session completed a task or skill. |
| `produced` | Output | Session produced an artifact or result. |
| `implemented` | Implementation | Session implemented a feature. |
| `evaluated` | Outcome feedback | Decision received a delta score. |

Because predicates are case-sensitive and shared, inventing new ones without updating the vocabulary fragments the graph. The rule is: use the canonical set, or extend it deliberately and document the extension.

## Invalidation: Facts That Change

Reality changes. A decision is reversed. A preference updates. A project is no longer active. The graph handles this with **invalidation**, not deletion.

When a fact is no longer true, it is marked with an `ended` date. The fact remains in the graph, so queries about the past still return accurate results, but current queries exclude it.

This is important because "what was true then" and "what is true now" are both valid questions. Deleting a fact would erase history; invalidation preserves it.

## What the Graph Enables

The structured shape of the graph unlocks several capabilities that raw notes do not:

### Timeline Queries

Ask for the chronological history of any entity. This is useful for understanding how a decision evolved, when a skill was last used, or what outputs a session produced.

### Outcome Tracing

A decision can be linked to its later evaluation. This closes the learning loop: Penny records what was expected, then records what happened, and the graph connects the two.

### Preference Learning

User preferences stored as facts can be queried by topic, source, or time. A preference learned in one session can influence the next session without relying on search relevance.

### Dependency Discovery

By following `uses`, `produced`, and `implemented` links, you can map which skills, tools, and artifacts depend on each other. This helps with impact analysis when something changes.

## Trade-offs

The graph is powerful, but it is not free.

| Advantage | Cost |
| --- | --- |
| Precise, queryable relationships | Requires consistent entity naming and predicate vocabulary |
| Temporal reasoning | Every fact needs careful invalidation when it changes |
| Cross-session continuity | Adds a structured step to workflows that might otherwise just write prose |

The payoff is highest for information that is referenced repeatedly or that changes over time. For one-off notes that no one will query, a drawer alone is enough.

## How the Graph Relates to Other Memory Layers

- **Drawers** hold verbatim text: notes, decisions, session summaries.
- **Semantic search** finds relevant drawers based on meaning.
- **The knowledge graph** links entities across those drawers and sessions.

In practice, a workflow often stores a detailed note in a drawer and then adds one or more graph facts that point at the entities inside it. Search finds the prose; the graph finds the relationships.

## Learn More

- [Memory integration guide](integration.md) — how skills and extensions store and retrieve memory.
- Agent reference: `docs/agents/memory/kg-patterns.md` — the machine-readable predicate and linking conventions.
