# AGENTS.md Standard

## Purpose

`AGENTS.md` is Penny's advisory routing layer. It tells an agent which direct-child
source to read; the source document owns the rules. Routing text is not enforcement:
semantic resolution, dependency closure, and receipts remain future work.

Exactly two file classes exist.

## Repository bootstrap `AGENTS.md`

The repository root is the sole bounded bootstrap exception. It may contain concise,
always-applicable repository invariants, documentation traversal semantics,
trigger-to-index lookup guidance, and its next-level index. It must not contain
conditional domain procedures or link past the next index level.

The root is constrained by the checker to one H1, a bounded line/byte budget,
relative next-level `AGENTS.md` links only, and no operator filesystem paths. It
is the bootstrap context, not a second system prompt.

## Nested routing indexes

Every other tracked `AGENTS.md` is a one-level routing index. It contains exactly:

1. One level-one heading.
2. One complete, one-line entry for every tracked direct-child Markdown document
   and direct child directory that owns an `AGENTS.md`.

Each entry uses this grammar:

```markdown
- [Title](path): MUST READ FOR <scope> — <what the document supplies>
- [Title](path): READ WHEN <positive trigger> — <what the document supplies>
- [Title](path): CONSULT WHEN <question> — <what the document supplies>
```

Nested indexes contain no substantive rules, examples, procedures, cross-cutting
prose, or headings beyond the H1. Links are relative direct children only; they may
not leave the directory or skip a level. Direct-child completeness prevents orphaned
routing targets.

## Routing modalities

- **MUST READ FOR `<scope>`** — a mandatory prerequisite whenever the stated scope
  applies. Read and apply it before planning, implementation, review, or completion.
  Use it only for clear baselines whose omission risks serious harm or makes required
  guidance easy to overlook.
- **READ WHEN `<positive trigger>`** — a conditional prerequisite when the task
  includes the stated operation, feature, technology, or trust boundary.
- **CONSULT WHEN `<question>`** — optional reference for an unresolved informational
  question. It cannot replace a mandatory or triggered route.

Write a concrete positive trigger with an operation or task facet before the em dash.
Do not use negative exclusions as routing grammar; multiple siblings may apply to the
same task. The checker enforces these three prefixes and index shape only. It does not
infer semantic applicability or dependency closure.

## Shared scopes

A **code-affecting task** creates, modifies, reviews, diagnoses, or recommends
executable code, tests, dependencies, schemas or migrations, build/deployment/
infrastructure configuration, or data flows that affect executable behavior.

A **Penny-system-affecting task** creates, changes, reviews, diagnoses, or applies
Penny's agents, extensions, skills, prompts, memory, orchestration, capabilities,
state management, knowledge-base behavior, architecture, protocols, root/index
routing, or agent-facing guidance.

These scopes include implementation and read-only work. They determine what guidance
must be read, not whether the task must ship code or tests. Implementation must produce
and run suitable evidence; review/diagnosis must assess available evidence and gaps;
recommendation/planning must identify affected requirements and needed evidence without
claiming an unimplemented control exists.

## Retrieval discipline

Read every mandatory baseline on the active route, every guide triggered by the task's
features and trust boundaries, and every explicit dependency needed to apply them. Stop
when additional documents would not change the implementation, review, or verification
approach. Do not use a fixed document-count limit to omit mandatory or triggered
material, and do not load unrelated branches.

When a system document is in scope, read it completely and follow its load-bearing
Markdown cross-references. Trigger-gated protocols under `docs/penny/` remain gated by
their trusted activation conditions; typed entries do not make them always-on.

## Scope and human documentation

The checker enumerates tracked paths with `git ls-files`; it must not scan ignored or
operator-configured private content. `docs/humans/` has no `AGENTS.md` and does not use
the routing grammar. A shared conceptual change may need a minimal parallel human-page
update, but human navigation remains prose-based.

## Paths and current-state documentation

Paths live in the index chain, never in the always-on Cognitive Frame. Documentation
describes current behavior rather than retaining deprecation ledgers; update or remove
superseded paths in the same change.

## Example

```markdown
# Prompts Feature Index

- [Architecture](architecture.md): READ WHEN changing prompt assembly or recovery — layer ownership and runtime boundaries.
- [Layer Reference](layer-reference.md): CONSULT WHEN resolving a layer-ownership question — concise responsibility map.
```
