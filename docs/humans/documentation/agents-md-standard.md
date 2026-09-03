# AGENTS.md Files

## What They Are

Penny uses `AGENTS.md` files as a lightweight routing layer for agent-facing
reference material. The repository-root file is a small bootstrap exception: it
contains only global repository boundaries, navigation rules, trigger lookup guidance,
and top-level links. Every nested `AGENTS.md` is a compact index of its direct children;
the actual rules live in the document behind each route.

## Typed Routing

Nested entries say both when to read a document and what it supplies. They use one of
three action phrases:

- **MUST READ FOR** a defined scope: a prerequisite baseline.
- **READ WHEN** a concrete task feature or trust boundary is present.
- **CONSULT WHEN** an unresolved informational question remains.

The wording is navigation help, not a runtime enforcement mechanism. It uses positive
triggers because one task can need several related guides. A future resolver may make
selection and dependency closure deterministic; the current checker only verifies the
index structure and routing vocabulary.

## Reading Discipline

Read every mandatory baseline on the active route, every guide triggered by the task,
and any explicit dependency needed to apply them. Stop when another document would not
change the implementation, review, or verification approach. This avoids both greedy
loading and a fixed file-count shortcut that can omit important guidance.

System documentation remains load-bearing once selected: read it completely and follow
its relevant references. Trigger-gated protocol documents remain on demand.

## Human Documentation Is Different

`docs/humans/` has no `AGENTS.md` files. It is prose for people, while the agent tree
is a navigation system for on-demand guidance. The two should agree on shared concepts
without making human documentation a second routing index.

## Learn More

- [Documentation System Overview](overview.md): How this fits into the larger docs structure.
- Agent-facing reference: [AGENTS.md Standard](../../agents/documentation/agents-md-standard.md)
