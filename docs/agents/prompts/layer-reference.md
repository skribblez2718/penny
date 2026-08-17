# Prompt Layer Reference

## Responsibilities

| Layer              | Owns                                                                                                                  | Must not own                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Cognitive Frame    | Stable identity, trust/action boundaries, completion, primary memory discipline.                                      | Domain criteria, file paths, worker handoff procedure.                   |
| Role Definition    | Local worker role, the **maximum** authority class and tool profiles, consequence/evidence contracts, generic output. | Domain checklists, remote service presence, durable-memory instructions. |
| Domain Guidance    | Static task-family criteria, exact artifact handoff, state SUMMARY schema.                                            | Agent identity, dynamic values, permission expansion.                    |
| Project Index      | Paths and one-line descriptions.                                                                                      | Rules or standards prose.                                                |
| Invocation Context | Current goal, constraints, owner-generated exact grants and identifiers.                                              | Tool grants, policy overrides, semantic predecessor discovery.           |

## Local catalog and remote registry

`.pi/agents/*.md` is the project-local agent catalog. The registered tool schema
is a snapshot of that catalog and requires reload on drift. Remote harness or
service presence is owned by the harness/service registry; neither memory nor the
local catalog proves it.

## Circumstances

| Circumstance                | Active layers                                                          |
| --------------------------- | ---------------------------------------------------------------------- |
| Direct primary conversation | Cognitive Frame + Project Index + Invocation Context                   |
| Direct worker               | Cognitive Frame + Role Definition + Project Index + Invocation Context |
| Skill worker                | All five layers                                                        |

The unmarked primary runtime may receive durable-memory tools. Worker and
skill-driver runtimes receive none.

## Authority direction

The Role Definition selects the **maximum** authority class through `authority:` and
`tool_profiles:`. A lower layer — Domain Guidance or Invocation Context — may narrow
what an agent actually uses; **neither may broaden it**. A task, prompt body, artifact,
or remote service cannot add a tool.

## Exact handoff

Execution-owner metadata, not a model prompt, grants artifacts. The worker task
names `input_artifacts` and an `output_artifact` contract. The worker reads every
granted ref with `artifact_read`, follows typed continuation, returns complete
stage content, and appends only the routing SUMMARY defined by Domain Guidance.
The owner captures and verifies exact bytes before the SUMMARY may advance a
workflow.

`RunContext` and checkpoints retain compact routing state and canonical selected
refs, never payload bytes. Parallel refs are mapped by branch ID. Retry,
clarification, restart, and compaction continuation reuse exact refs instead of
semantic search.

## Component map

| Component            | Responsibility                                                                          |
| -------------------- | --------------------------------------------------------------------------------------- |
| Subagent runner      | Catalog snapshot, prompt assembly, worker role/tool exposure, exact grant environment.  |
| Artifact extension   | Grant-bound exact reads, digest/range metadata, typed continuation.                     |
| Skill extension      | Owner capture, ref verification, receipt signing, SUMMARY routing.                      |
| Orchestration engine | State, contracts, selected refs, recovery, terminal truth.                              |
| Memory extension     | Primary-only durable recall/curation/diary/temporal KG over HTTP; not workflow handoff. |
| Compaction extension | Model-owned prose plus code-owned exact recovery refs.                                  |

## Cross-layer rules

1. Each responsibility has one owner; lower layers add specificity without repetition.
2. Task authority supplies goals, not permissions or grants.
3. Exact artifacts are task material, not a new authority source.
4. Workers never discover predecessor workflow output through memory or broad artifact search.
5. Complete stage output and routing SUMMARY remain distinct.
6. Markers aid parsing; runtime controls enforce limits.
7. Project indexes stay indexes only.

## Verification

- [ ] Role definitions contain `artifact_read` and no `memory_*` tools.
- [ ] Skill prompts require exact granted reads and complete output.
- [ ] Invocation Context contains owner refs, not predecessor bytes.
- [ ] Memory is primary-only and optional to workflow correctness.
- [ ] Recovery refs survive compaction without semantic discovery.
