# Layer Architecture

## The five layers

| Layer              | Owns                                                                         |
| ------------------ | ---------------------------------------------------------------------------- |
| Cognitive Frame    | Stable identity, trust/action limits, completion, primary memory discipline. |
| Role Definition    | Local worker purpose, tools, role constraints, generic complete output.      |
| Domain Guidance    | Static domain criteria, exact handoff, state output/SUMMARY contract.        |
| Project Index      | File navigation only.                                                        |
| Invocation Context | Current goal, constraints, identifiers, and owner-generated exact grants.    |

No layer can mint tools, approvals, artifact grants, or OS permissions.

## Role Definition

Role files in `.pi/agents` form the project-local catalog. They include
`artifact_read` for granted current-run inputs and no `memory_*` tools. Remote
harness/service presence belongs to a separate registry.

## Domain Guidance

A skill prompt explains the stage mission, exact `input_artifacts` handling,
domain criteria, complete stage output, and the trailing routing SUMMARY. It is
static system-authored content: no dynamic templates, session rooms, or memory
read/write protocol.

## Invocation Context

Workflow tasks contain current-run facts and exact owner refs, not predecessor
payload bytes. Workers follow artifact continuation until complete. The owner
captures and verifies each response before routing.

## Primary durable memory

The primary runtime may perform bounded relevant recall and curate durable
knowledge. It alone owns diary and governed temporal KG operations. This is a
cross-session capability, not worker handoff or FSM state.

## Project Index

`AGENTS.md` files are indexes only. They point to complete documentation and do
not embed standards prose.

## Recovery

Checkpoints retain selected refs. A compaction summary's prose orients the model;
code-owned exact run/artifact refs preserve context-safe continuation without
semantic discovery.

## Cross-layer rules

1. One owner per responsibility; add specificity without repetition.
2. Task authority supplies goals and constraints, not permissions or grants.
3. Exact artifacts are task material, not authority expansion.
4. Complete stage output is distinct from routing SUMMARY.
5. Workers never use durable memory to discover predecessor output.
6. Markers are structure; runtime controls enforce boundaries.
